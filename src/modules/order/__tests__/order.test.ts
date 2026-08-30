import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import {
  User,
  Product,
  Order,
  OrderStatus,
  ORDER_STATUS_TRANSITIONS,
} from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { generateOrderNumber } from "../order.service";
import { cancelStalePendingOrders, PENDING_ORDER_TTL_MS } from "../orderCleanup";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `73${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    firstName: "Test",
    lastName: `Customer${createdUserIds.length}`,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

async function makeProduct(stock = 10) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Order Product ${RUN_ID}-${n}`,
    slug: `order-product-${RUN_ID}-${n}`,
    sku: `OR-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1000, sellingPrice: 800 },
    inventory: { stockQuantity: stock, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["order"] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

async function makeAddress(user: InstanceType<typeof User>): Promise<string> {
  const res = await request(app)
    .post("/api/addresses")
    .set("Cookie", authCookie(user))
    .send({ label: "Home", line1: "12 Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020" });
  return res.body.data.address.addressId;
}

async function placeOrder(user: InstanceType<typeof User>, product: { _id: mongoose.Types.ObjectId }, quantity = 2) {
  const addressId = await makeAddress(user);
  const res = await request(app)
    .post("/api/checkout")
    .set("Cookie", authCookie(user))
    .set("Idempotency-Key", `order-test-${RUN_ID}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ productId: product._id.toString(), quantity }],
      addressId,
      paymentMethod: "COD",
    });
  expect(res.status).toBe(201);
  return res.body.data.order as { orderId: string; orderNumber: string; status: OrderStatus };
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const doc = await Product.findById(productId).select("inventory").lean();
  return doc!.inventory.stockQuantity;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Order numbers", () => {
  it("has the documented shape and is not sequential", () => {
    const a = generateOrderNumber(new Date("2026-08-22T10:00:00Z"));
    expect(a).toMatch(/^ORD-\d{8}-[23456789A-HJ-NP-Z]{6}$/);
    const many = new Set(Array.from({ length: 200 }, () => generateOrderNumber()));
    expect(many.size).toBe(200);
  });
});

describe("Order status transition table", () => {
  it("treats CANCELLED and REFUNDED as terminal", () => {
    expect(ORDER_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    expect(ORDER_STATUS_TRANSITIONS.REFUNDED).toEqual([]);
  });

  it("only allows cancellation before the parcel is in transit", () => {
    const cancellable = (Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]).filter((s) =>
      ORDER_STATUS_TRANSITIONS[s].includes("CANCELLED")
    );
    expect(cancellable.sort()).toEqual(["CONFIRMED", "PENDING_PAYMENT", "PROCESSING"]);
  });
});

describe("Order API — customer", () => {
  it("401s without a session", async () => {
    expect((await request(app).get("/api/orders")).status).toBe(401);
  });

  it("lists only the caller's own orders", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(userA, product);

    const listA = await request(app).get("/api/orders").set("Cookie", authCookie(userA));
    expect(listA.status).toBe(200);
    expect(listA.body.data.items.map((o: { orderNumber: string }) => o.orderNumber)).toContain(order.orderNumber);

    const listB = await request(app).get("/api/orders").set("Cookie", authCookie(userB));
    expect(listB.body.data.items).toEqual([]);
    expect(listB.body.data.total).toBe(0);
  });

  it("fetches an order by orderNumber", async () => {
    const user = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(user, product);

    const res = await request(app).get(`/api/orders/${order.orderNumber}`).set("Cookie", authCookie(user));
    expect(res.status).toBe(200);
    expect(res.body.data.order.orderNumber).toBe(order.orderNumber);
    expect(res.body.data.order.shippingAddress.city).toBe("Mumbai");
    expect(res.body.data.order.cancellable).toBe(true);
  });

  it("404s on an unknown order number", async () => {
    const user = await makeUser();
    const res = await request(app).get("/api/orders/ORD-20260101-ZZZZZZ").set("Cookie", authCookie(user));
    expect(res.status).toBe(404);
  });
});

describe("Order API — IDOR protection", () => {
  it("user B cannot read user A's order even knowing the order number", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(userA, product);

    const res = await request(app).get(`/api/orders/${order.orderNumber}`).set("Cookie", authCookie(userB));
    expect(res.status).toBe(404);
  });

  it("user B cannot cancel user A's order", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(userA, product);

    const res = await request(app)
      .post(`/api/orders/${order.orderNumber}/cancel`)
      .set("Cookie", authCookie(userB))
      .send({ reason: "not mine" });
    expect(res.status).toBe(404);

    // A's order is untouched — the 404 wasn't a cancel that merely failed to
    // report itself.
    const doc = await Order.findOne({ orderNumber: order.orderNumber }).lean();
    expect(doc!.status).toBe("CONFIRMED");
  });
});

describe("Order API — cancellation", () => {
  it("cancels and restores stock", async () => {
    const user = await makeUser();
    const product = await makeProduct(10);
    const order = await placeOrder(user, product, 3);
    expect(await stockOf(product._id)).toBe(7);

    const res = await request(app)
      .post(`/api/orders/${order.orderNumber}/cancel`)
      .set("Cookie", authCookie(user))
      .send({ reason: "Changed my mind" });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe("CANCELLED");
    expect(res.body.data.order.cancelReason).toBe("Changed my mind");
    expect(res.body.data.order.cancellable).toBe(false);
    expect(await stockOf(product._id)).toBe(10);

    const history = res.body.data.order.statusHistory;
    expect(history[history.length - 1].status).toBe("CANCELLED");
  });

  it("409s cancelling an order that has already shipped", async () => {
    const user = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(user, product);

    await Order.updateOne({ orderNumber: order.orderNumber }, { $set: { status: "SHIPPED" } });

    const res = await request(app)
      .post(`/api/orders/${order.orderNumber}/cancel`)
      .set("Cookie", authCookie(user))
      .send({});
    expect(res.status).toBe(409);

    const doc = await Order.findOne({ orderNumber: order.orderNumber }).lean();
    expect(doc!.status).toBe("SHIPPED");
  });

  it("409s cancelling an already-cancelled order (terminal state)", async () => {
    const user = await makeUser();
    const product = await makeProduct(10);
    const order = await placeOrder(user, product, 2);

    await request(app).post(`/api/orders/${order.orderNumber}/cancel`).set("Cookie", authCookie(user)).send({});
    const second = await request(app)
      .post(`/api/orders/${order.orderNumber}/cancel`)
      .set("Cookie", authCookie(user))
      .send({});

    expect(second.status).toBe(409);
    // Critically: the stock was restored once, not twice.
    expect(await stockOf(product._id)).toBe(10);
  });
});

describe("Admin order API", () => {
  it("403s for a non-admin session", async () => {
    const user = await makeUser();
    const res = await request(app).get("/api/admin/orders").set("Cookie", authCookie(user));
    expect(res.status).toBe(403);
  });

  it("lists orders with the customer label and filters by status", async () => {
    const admin = await makeUser("admin");
    const customer = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(customer, product);

    const res = await request(app).get("/api/admin/orders").set("Cookie", authCookie(admin));
    expect(res.status).toBe(200);
    const found = res.body.data.items.find((o: { orderNumber: string }) => o.orderNumber === order.orderNumber);
    expect(found).toBeTruthy();
    expect(found.customer).toBe(`${customer.firstName} ${customer.lastName}`);
    expect(found.items).toBe(1);
    expect(found.paymentStatus).toBe("PENDING");

    const filtered = await request(app)
      .get("/api/admin/orders?status=CANCELLED")
      .set("Cookie", authCookie(admin));
    expect(
      filtered.body.data.items.every((o: { status: string }) => o.status === "CANCELLED")
    ).toBe(true);
  });

  it("advances status along the transition table and rejects illegal jumps", async () => {
    const admin = await makeUser("admin");
    const customer = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(customer, product);

    const ok = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "PROCESSING", note: "Picked" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.order.status).toBe("PROCESSING");

    // PROCESSING -> DELIVERED skips SHIPPED/OUT_FOR_DELIVERY.
    const bad = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "DELIVERED" });
    expect(bad.status).toBe(409);

    const detail = await request(app)
      .get(`/api/admin/orders/${order.orderId}`)
      .set("Cookie", authCookie(admin));
    expect(detail.body.data.order.allowedNextStatuses).toEqual(["SHIPPED", "CANCELLED"]);
    expect(detail.body.data.order.customer.phone).toBe(customer.phone);
  });

  it("restores stock when an admin cancels", async () => {
    const admin = await makeUser("admin");
    const customer = await makeUser();
    const product = await makeProduct(10);
    const order = await placeOrder(customer, product, 4);
    expect(await stockOf(product._id)).toBe(6);

    const res = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "CANCELLED", note: "Out of stock at warehouse" });

    expect(res.status).toBe(200);
    expect(await stockOf(product._id)).toBe(10);
  });

  it("409s refunding a COD order", async () => {
    const admin = await makeUser("admin");
    const customer = await makeUser();
    const product = await makeProduct();
    const order = await placeOrder(customer, product);

    const res = await request(app)
      .post(`/api/admin/orders/${order.orderId}/refund`)
      .set("Cookie", authCookie(admin))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Cash on Delivery/i);
  });
});

describe("Stale pending-order cleanup", () => {
  it("cancels PENDING_PAYMENT orders past the TTL and gives the stock back", async () => {
    const user = await makeUser();
    const product = await makeProduct(10);
    const order = await placeOrder(user, product, 3);

    // Backdate it and put it in the state a never-completed Razorpay
    // checkout would have left behind. Written through the raw driver
    // because Mongoose's timestamps plugin strips a manual `createdAt` out
    // of an update.
    await Order.collection.updateOne(
      { orderNumber: order.orderNumber },
      { $set: { status: "PENDING_PAYMENT", createdAt: new Date(Date.now() - PENDING_ORDER_TTL_MS - 60_000) } }
    );

    const result = await cancelStalePendingOrders();
    expect(result.cancelled).toBeGreaterThanOrEqual(1);

    const doc = await Order.findOne({ orderNumber: order.orderNumber }).lean();
    expect(doc!.status).toBe("CANCELLED");
    expect(doc!.paymentStatus).toBe("FAILED");
    expect(await stockOf(product._id)).toBe(10);
  });

  it("leaves a fresh PENDING_PAYMENT order alone", async () => {
    const user = await makeUser();
    const product = await makeProduct(10);
    const order = await placeOrder(user, product, 2);
    await Order.updateOne({ orderNumber: order.orderNumber }, { $set: { status: "PENDING_PAYMENT" } });

    await cancelStalePendingOrders();

    const doc = await Order.findOne({ orderNumber: order.orderNumber }).lean();
    expect(doc!.status).toBe("PENDING_PAYMENT");
    expect(await stockOf(product._id)).toBe(8);
  });
});
