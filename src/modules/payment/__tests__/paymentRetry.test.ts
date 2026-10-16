import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";

// The gateway's network call is the only thing replaced; everything else
// (state machine, DB claims, DTO) runs for real.
const fetchPayments = vi.hoisted(() => vi.fn());
vi.mock("../../../common/payments/razorpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/payments/razorpay")>()),
  fetchRazorpayOrderPayments: fetchPayments,
}));

import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { createOrderWithUniqueNumber } from "../../order/order.service";
import { PENDING_ORDER_TTL_MS } from "../../order/orderPaymentWindow";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser() {
  const user = await User.create({
    phone: `72${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
  });
  createdUserIds.push(user._id);
  return user;
}
const cookieFor = (user: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(user)}`;

async function makeProduct(stock = 10) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Retry Product ${RUN_ID}-${n}`,
    slug: `retry-product-${RUN_ID}-${n}`,
    sku: `RT-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1000, sellingPrice: 800 },
    inventory: { stockQuantity: stock, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["retry"] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

async function makePendingOrder(
  user: InstanceType<typeof User>,
  opts: { method?: "RAZORPAY" | "COD"; ageMs?: number; razorpayOrderId?: string } = {}
) {
  const product = await makeProduct();
  const doc = await createOrderWithUniqueNumber({
    userId: user._id,
    items: [
      { productId: product._id, name: product.name, sku: product.sku, imageUrl: null, quantity: 1, unitPrice: 800, mrp: 1000, discount: 200, discountPercentage: 20, lineTotal: 800 },
    ],
    pricing: { subtotal: 800, shippingFee: 49, taxTotal: 0, grandTotal: 849 },
    shippingAddress: { line1: "12 Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020" },
    status: "PENDING_PAYMENT",
    paymentMethod: opts.method ?? "RAZORPAY",
    paymentStatus: "PENDING",
    statusHistory: [{ status: "PENDING_PAYMENT", at: new Date(), note: "Order placed" }],
  });
  if ((opts.method ?? "RAZORPAY") === "RAZORPAY") {
    doc.payment = { razorpayOrderId: opts.razorpayOrderId ?? `order_${RUN_ID}_${createdProductIds.length}` };
    await doc.save();
  }
  // Raw driver write: Mongoose's timestamps plugin strips a manual createdAt.
  if (opts.ageMs) await Order.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - opts.ageMs) } });
  return doc;
}

const pay = (user: InstanceType<typeof User>, orderNumber: string) =>
  request(app).post(`/api/orders/${orderNumber}/pay`).set("Cookie", cookieFor(user));

beforeAll(async () => {
  await connectDatabase();
});

beforeEach(() => {
  fetchPayments.mockReset();
  fetchPayments.mockResolvedValue([]);
});

afterAll(async () => {
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("POST /orders/:orderNumber/pay — retry payment", () => {
  it("returns the SAME Razorpay order so the customer can pay again", async () => {
    const user = await makeUser();
    const order = await makePendingOrder(user, { razorpayOrderId: `order_${RUN_ID}_same` });

    const res = await pay(user, order.orderNumber);

    expect(res.status).toBe(200);
    expect(res.body.data.alreadyPaid).toBe(false);
    expect(res.body.data.razorpayOrder).toEqual({ id: `order_${RUN_ID}_same`, amount: 84900, currency: "INR" });
    // Nothing was re-reserved or changed.
    const doc = await Order.findById(order._id).lean();
    expect(doc!.status).toBe("PENDING_PAYMENT");
    expect(doc!.payment!.razorpayOrderId).toBe(`order_${RUN_ID}_same`);
  });

  it("exposes payBy on the order only while it can still be paid", async () => {
    const user = await makeUser();
    const open = await makePendingOrder(user);
    const stale = await makePendingOrder(user, { ageMs: PENDING_ORDER_TTL_MS - 60_000 }); // < 3 min left
    const cod = await makePendingOrder(user, { method: "COD" });

    const get = (n: string) => request(app).get(`/api/orders/${n}`).set("Cookie", cookieFor(user));
    expect((await get(open.orderNumber)).body.data.order.payBy).toEqual(expect.any(String));
    expect((await get(stale.orderNumber)).body.data.order.payBy).toBeNull();
    expect((await get(cod.orderNumber)).body.data.order.payBy).toBeNull();
  });

  it("refuses once the payment window is (nearly) closed", async () => {
    const user = await makeUser();
    const order = await makePendingOrder(user, { ageMs: PENDING_ORDER_TTL_MS - 60_000 });
    const res = await pay(user, order.orderNumber);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/payment window/i);
  });

  it("refuses cancelled orders and COD orders", async () => {
    const user = await makeUser();
    const cancelled = await makePendingOrder(user);
    await Order.updateOne({ _id: cancelled._id }, { $set: { status: "CANCELLED" } });
    expect((await pay(user, cancelled.orderNumber)).status).toBe(409);

    const cod = await makePendingOrder(user, { method: "COD" });
    expect((await pay(user, cod.orderNumber)).status).toBe(409);
  });

  it("does not let another user pay (or even see) someone else's order", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const order = await makePendingOrder(owner);
    expect((await pay(other, order.orderNumber)).status).toBe(404);
  });

  it("settles the order instead of charging again when the gateway already captured a payment", async () => {
    const user = await makeUser();
    const order = await makePendingOrder(user, { razorpayOrderId: `order_${RUN_ID}_captured` });
    fetchPayments.mockResolvedValue([
      { id: "pay_failed_1", status: "failed" },
      { id: "pay_captured_1", status: "captured" },
    ]);

    const res = await pay(user, order.orderNumber);

    expect(res.status).toBe(200);
    expect(res.body.data.alreadyPaid).toBe(true);
    expect(res.body.data.razorpayOrder).toBeNull();
    const doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("PAID");
    expect(doc!.status).toBe("CONFIRMED");
    expect(doc!.payment!.razorpayPaymentId).toBe("pay_captured_1");
  });

  it("reports an already-paid order as paid without calling the gateway", async () => {
    const user = await makeUser();
    const order = await makePendingOrder(user);
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: "PAID", status: "CONFIRMED" } });
    const res = await pay(user, order.orderNumber);
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyPaid).toBe(true);
    expect(fetchPayments).not.toHaveBeenCalled();
  });
});

describe("POST /orders/:orderNumber/cancel — atomic", () => {
  it("restores stock exactly once when cancel is fired twice at the same time", async () => {
    const user = await makeUser();
    const order = await makePendingOrder(user);
    const productId = order.items[0].productId;
    const before = (await Product.findById(productId).select("inventory").lean())!.inventory.stockQuantity;

    const cancel = () => request(app).post(`/api/orders/${order.orderNumber}/cancel`).set("Cookie", cookieFor(user)).send({});
    const results = await Promise.all([cancel(), cancel()]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = (await Product.findById(productId).select("inventory").lean())!.inventory.stockQuantity;
    expect(after).toBe(before + order.items[0].quantity);
    const doc = await Order.findById(order._id).lean();
    expect(doc!.status).toBe("CANCELLED");
    expect(doc!.statusHistory.filter((h) => h.status === "CANCELLED")).toHaveLength(1);
  });
});
