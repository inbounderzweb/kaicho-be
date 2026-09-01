import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order, OrderStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `74${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    firstName: "Ship",
    lastName: `Tester${createdUserIds.length}`,
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
    name: `Ship Product ${RUN_ID}-${n}`,
    slug: `ship-product-${RUN_ID}-${n}`,
    sku: `SH-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1000, sellingPrice: 800 },
    inventory: { stockQuantity: stock, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["ship"] },
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

// A COD checkout lands the order straight in CONFIRMED — ready to ship.
async function placeOrder(user: InstanceType<typeof User>, product: { _id: mongoose.Types.ObjectId }) {
  const addressId = await makeAddress(user);
  const res = await request(app)
    .post("/api/checkout")
    .set("Cookie", authCookie(user))
    .set("Idempotency-Key", `ship-test-${RUN_ID}-${Math.random().toString(36).slice(2)}`)
    .send({ items: [{ productId: product._id.toString(), quantity: 1 }], addressId, paymentMethod: "COD" });
  expect(res.status).toBe(201);
  return res.body.data.order as { orderId: string; orderNumber: string; status: OrderStatus };
}

const VALID_SHIPMENT = {
  carrier: "Delhivery",
  trackingNumber: "DL-1234567890",
  shipmentId: "SHIP-99",
  trackingUrl: "https://www.delhivery.com/track/package/DL-1234567890",
};

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Shipment API — auth", () => {
  it("403s for a non-admin session on both shipment routes", async () => {
    const user = await makeUser();
    const order = await placeOrder(user, await makeProduct());

    const put = await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(user))
      .send(VALID_SHIPMENT);
    expect(put.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/shipment/status`)
      .set("Cookie", authCookie(user))
      .send({ status: "PACKED" });
    expect(patch.status).toBe(403);
  });
});

describe("Shipment API — create + order-status sync", () => {
  it("saves the shipment and advances the order along the fulfilment path", async () => {
    const admin = await makeUser("admin");
    const customer = await makeUser();
    const order = await placeOrder(customer, await makeProduct());

    const res = await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(admin))
      .send({ ...VALID_SHIPMENT, shippedAt: "2026-09-01", estimatedDeliveryAt: "2026-09-05" });

    expect(res.status).toBe(200);
    const dto = res.body.data.order;
    expect(dto.shipment.carrier).toBe("Delhivery");
    expect(dto.shipment.trackingNumber).toBe("DL-1234567890");
    expect(dto.shipment.status).toBe("SHIPPED"); // defaulted
    expect(dto.shipment.trackingUrl).toContain("delhivery.com");
    // CONFIRMED -> PROCESSING -> SHIPPED, both hops auto-recorded.
    expect(dto.status).toBe("SHIPPED");
    const autoHops = dto.statusHistory.filter(
      (h: { note?: string }) => h.note === "Auto-updated from shipment"
    );
    expect(autoHops.map((h: { status: string }) => h.status)).toEqual(["PROCESSING", "SHIPPED"]);
  });

  it("only moves the order as far as the shipment status implies", async () => {
    const admin = await makeUser("admin");
    const order = await placeOrder(await makeUser(), await makeProduct());

    const res = await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(admin))
      .send({ ...VALID_SHIPMENT, status: "PACKED" });

    expect(res.status).toBe(200);
    expect(res.body.data.order.shipment.status).toBe("PACKED");
    expect(res.body.data.order.status).toBe("PROCESSING"); // not SHIPPED
  });
});

describe("Shipment API — validation", () => {
  it("rejects a malformed tracking number, a non-URL tracking link, and an inverted date range", async () => {
    const admin = await makeUser("admin");
    const order = await placeOrder(await makeUser(), await makeProduct());
    const url = `/api/admin/orders/${order.orderId}/shipment`;

    expect(
      (await request(app).put(url).set("Cookie", authCookie(admin)).send({ carrier: "DTDC", trackingNumber: "no spaces!" })).status
    ).toBe(400);

    expect(
      (await request(app).put(url).set("Cookie", authCookie(admin)).send({ ...VALID_SHIPMENT, trackingUrl: "not-a-url" })).status
    ).toBe(400);

    expect(
      (
        await request(app)
          .put(url)
          .set("Cookie", authCookie(admin))
          .send({ ...VALID_SHIPMENT, shippedAt: "2026-09-10", estimatedDeliveryAt: "2026-09-01" })
      ).status
    ).toBe(400);
  });

  it("409s when trying to ship an unpaid order", async () => {
    const admin = await makeUser("admin");
    const order = await placeOrder(await makeUser(), await makeProduct());
    await Order.updateOne({ _id: order.orderId }, { $set: { status: "PENDING_PAYMENT" } });

    const res = await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(admin))
      .send(VALID_SHIPMENT);
    expect(res.status).toBe(409);
  });
});

describe("Shipment API — status updates", () => {
  it("walks the order forward, stamps deliveredAt, and 409s before a shipment exists", async () => {
    const admin = await makeUser("admin");
    const order = await placeOrder(await makeUser(), await makeProduct());

    const early = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/shipment/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "OUT_FOR_DELIVERY" });
    expect(early.status).toBe(409);

    await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(admin))
      .send({ ...VALID_SHIPMENT, status: "PACKED" });

    const ofd = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/shipment/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "OUT_FOR_DELIVERY" });
    expect(ofd.status).toBe(200);
    expect(ofd.body.data.order.status).toBe("OUT_FOR_DELIVERY");

    const delivered = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/shipment/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "DELIVERED", note: "Left with security" });
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.order.status).toBe("DELIVERED");
    expect(delivered.body.data.order.shipment.deliveredAt).not.toBeNull();
    const history = delivered.body.data.order.shipment.history;
    expect(history[history.length - 1]).toMatchObject({ status: "DELIVERED", note: "Left with security" });
  });

  it("records a failed delivery without moving the order status", async () => {
    const admin = await makeUser("admin");
    const order = await placeOrder(await makeUser(), await makeProduct());

    await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(admin))
      .send({ ...VALID_SHIPMENT, status: "OUT_FOR_DELIVERY" });

    const failed = await request(app)
      .patch(`/api/admin/orders/${order.orderId}/shipment/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "FAILED_DELIVERY", note: "Customer unreachable" });

    expect(failed.status).toBe(200);
    expect(failed.body.data.order.shipment.status).toBe("FAILED_DELIVERY");
    expect(failed.body.data.order.status).toBe("OUT_FOR_DELIVERY"); // unchanged
  });
});

describe("Shipment — customer visibility", () => {
  it("exposes the shipment on the customer order read but offers no write route", async () => {
    const admin = await makeUser("admin");
    const customer = await makeUser();
    const order = await placeOrder(customer, await makeProduct());

    await request(app)
      .put(`/api/admin/orders/${order.orderId}/shipment`)
      .set("Cookie", authCookie(admin))
      .send(VALID_SHIPMENT);

    const read = await request(app)
      .get(`/api/orders/${order.orderNumber}`)
      .set("Cookie", authCookie(customer));
    expect(read.status).toBe(200);
    expect(read.body.data.order.shipment.trackingNumber).toBe("DL-1234567890");

    // No customer-facing shipment mutation exists — the request falls through
    // to the catch-all `notFound` handler (which this app answers with a
    // version payload, not a 404), so there is no `data.order` in the reply
    // and the stored shipment is untouched.
    const write = await request(app)
      .put(`/api/orders/${order.orderNumber}/shipment`)
      .set("Cookie", authCookie(customer))
      .send({ ...VALID_SHIPMENT, carrier: "TamperCourier" });
    expect(write.body?.data).toBeUndefined();

    const stored = await Order.findById(order.orderId).lean();
    expect(stored!.shipment!.carrier).toBe("Delhivery");
  });
});
