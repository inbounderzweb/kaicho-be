import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { env } from "../../../config/env";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { verifyPaymentSignature, verifyWebhookSignature } from "../../../common/payments/razorpay";
import { createOrderWithUniqueNumber } from "../../order/order.service";

// Razorpay's network API is never called here. Everything under test is our
// own HMAC math and our own state machine — the two things that actually
// decide whether an order gets marked paid — verified against signatures
// computed with the same crypto primitives Razorpay uses.

const TEST_KEY_SECRET = "test-key-secret-for-hmac";
const TEST_WEBHOOK_SECRET = "test-webhook-secret-for-hmac";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

function paymentSignature(orderId: string, paymentId: string, secret = TEST_KEY_SECRET): string {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function webhookSignature(body: string, secret = TEST_WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function makeUser() {
  const user = await User.create({
    phone: `74${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
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
    name: `Payment Product ${RUN_ID}-${n}`,
    slug: `payment-product-${RUN_ID}-${n}`,
    sku: `PY-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1000, sellingPrice: 800 },
    inventory: { stockQuantity: stock, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["payment"] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

// A PENDING_PAYMENT Razorpay order in exactly the state createCheckout leaves
// behind, built directly so the test never has to reach the gateway to mint a
// real razorpayOrderId.
async function makePendingRazorpayOrder(user: InstanceType<typeof User>, razorpayOrderId: string) {
  const product = await makeProduct();
  return createOrderWithUniqueNumber({
    userId: user._id,
    items: [
      {
        productId: product._id,
        name: product.name,
        sku: product.sku,
        imageUrl: null,
        quantity: 1,
        unitPrice: 800,
        mrp: 1000,
        discount: 200,
        discountPercentage: 20,
        lineTotal: 800,
      },
    ],
    pricing: { subtotal: 800, shippingFee: 0, taxTotal: 0, grandTotal: 800 },
    shippingAddress: { line1: "12 Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020" },
    status: "PENDING_PAYMENT",
    paymentMethod: "RAZORPAY",
    paymentStatus: "PENDING",
    statusHistory: [{ status: "PENDING_PAYMENT", at: new Date(), note: "Order placed" }],
  }).then(async (doc) => {
    doc.payment = { razorpayOrderId };
    await doc.save();
    return doc;
  });
}

beforeAll(async () => {
  // env is a plain exported object and the wrapper reads it per call, so
  // this substitutes test secrets without needing a .env or a module mock —
  // and lets the real HMAC code path run rather than a stub of it.
  env.razorpayKeySecret = TEST_KEY_SECRET;
  env.razorpayWebhookSecret = TEST_WEBHOOK_SECRET;
  await connectDatabase();
});

afterAll(async () => {
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Razorpay signature helpers", () => {
  it("accepts a correctly computed payment signature", () => {
    const signature = paymentSignature("order_ABC123", "pay_XYZ789");
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", signature)).toBe(true);
  });

  it("rejects a tampered payment signature", () => {
    const signature = paymentSignature("order_ABC123", "pay_XYZ789");
    const tampered = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", tampered)).toBe(false);
  });

  it("rejects a signature computed for a different order", () => {
    const signature = paymentSignature("order_OTHER", "pay_XYZ789");
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", signature)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = paymentSignature("order_ABC123", "pay_XYZ789", "not-the-secret");
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", signature)).toBe(false);
  });

  it("rejects a truncated signature without throwing", () => {
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", "deadbeef")).toBe(false);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", "")).toBe(false);
  });

  it("verifies webhook signatures over the exact raw bytes", () => {
    const body = JSON.stringify({ event: "payment.captured" });
    expect(verifyWebhookSignature(Buffer.from(body), webhookSignature(body))).toBe(true);
    // Same JSON, different byte layout — must NOT verify, which is exactly
    // why app.ts keeps the raw buffer instead of re-serializing req.body.
    const respaced = JSON.stringify({ event: "payment.captured" }, null, 2);
    expect(verifyWebhookSignature(Buffer.from(respaced), webhookSignature(body))).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    const previous = env.razorpayKeySecret;
    env.razorpayKeySecret = "";
    try {
      expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", paymentSignature("order_ABC123", "pay_XYZ789"))).toBe(false);
    } finally {
      env.razorpayKeySecret = previous;
    }
  });
});

describe("POST /api/payments/razorpay/verify", () => {
  it("401s without a session", async () => {
    const res = await request(app).post("/api/payments/razorpay/verify").send({});
    expect(res.status).toBe(401);
  });

  it("marks the order paid and confirmed on a valid signature", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_ok`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);
    const paymentId = `pay_${RUN_ID}_ok`;

    const res = await request(app)
      .post("/api/payments/razorpay/verify")
      .set("Cookie", authCookie(user))
      .send({
        orderId: order._id.toString(),
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: paymentSignature(rzpOrderId, paymentId),
      });

    expect(res.status).toBe(200);
    expect(res.body.data.order.paymentStatus).toBe("PAID");
    expect(res.body.data.order.status).toBe("CONFIRMED");
    expect(res.body.data.order.payment.paidAt).toBeTruthy();
    // The signature is never echoed back to the client.
    expect(res.body.data.order.payment.razorpaySignature).toBeUndefined();
  });

  it("400s on a tampered signature and leaves the order unpaid", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_bad`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);

    const res = await request(app)
      .post("/api/payments/razorpay/verify")
      .set("Cookie", authCookie(user))
      .send({
        orderId: order._id.toString(),
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: `pay_${RUN_ID}_bad`,
        razorpaySignature: "0".repeat(64),
      });

    expect(res.status).toBe(400);
    const doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("PENDING");
    expect(doc!.status).toBe("PENDING_PAYMENT");
  });

  it("400s when the razorpayOrderId is not the one we created for this order", async () => {
    const user = await makeUser();
    const order = await makePendingRazorpayOrder(user, `order_${RUN_ID}_mine`);
    const foreign = `order_${RUN_ID}_someone_elses`;
    const paymentId = `pay_${RUN_ID}_foreign`;

    const res = await request(app)
      .post("/api/payments/razorpay/verify")
      .set("Cookie", authCookie(user))
      // A perfectly valid signature — for a different Razorpay order.
      .send({
        orderId: order._id.toString(),
        razorpayOrderId: foreign,
        razorpayPaymentId: paymentId,
        razorpaySignature: paymentSignature(foreign, paymentId),
      });

    expect(res.status).toBe(400);
    const doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("PENDING");
  });

  it("404s verifying another user's order", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_idor`;
    const order = await makePendingRazorpayOrder(userA, rzpOrderId);
    const paymentId = `pay_${RUN_ID}_idor`;

    const res = await request(app)
      .post("/api/payments/razorpay/verify")
      .set("Cookie", authCookie(userB))
      .send({
        orderId: order._id.toString(),
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: paymentSignature(rzpOrderId, paymentId),
      });

    expect(res.status).toBe(404);
  });

  it("is idempotent — a replayed verify succeeds without changing paidAt", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_replay`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);
    const paymentId = `pay_${RUN_ID}_replay`;
    const body = {
      orderId: order._id.toString(),
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: paymentSignature(rzpOrderId, paymentId),
    };

    const first = await request(app)
      .post("/api/payments/razorpay/verify")
      .set("Cookie", authCookie(user))
      .send(body);
    expect(first.status).toBe(200);
    const paidAt = first.body.data.order.payment.paidAt;

    const second = await request(app)
      .post("/api/payments/razorpay/verify")
      .set("Cookie", authCookie(user))
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.order.payment.paidAt).toBe(paidAt);

    const doc = await Order.findById(order._id).lean();
    // One CONFIRMED entry, not two.
    expect(doc!.statusHistory.filter((h) => h.status === "CONFIRMED")).toHaveLength(1);
  });
});

describe("POST /api/payments/razorpay/webhook", () => {
  function postWebhook(payload: unknown, signer: (body: string) => string = webhookSignature) {
    const body = JSON.stringify(payload);
    return request(app)
      .post("/api/payments/razorpay/webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signer(body))
      .send(body);
  }

  it("400s on a missing or invalid signature", async () => {
    const body = JSON.stringify({ event: "payment.captured" });
    const missing = await request(app)
      .post("/api/payments/razorpay/webhook")
      .set("Content-Type", "application/json")
      .send(body);
    expect(missing.status).toBe(400);

    const forged = await postWebhook({ event: "payment.captured" }, (b) => webhookSignature(b, "wrong-secret"));
    expect(forged.status).toBe(400);
  });

  it("200s (without 404ing) for an event referencing an unknown order", async () => {
    const res = await postWebhook({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_unknown", order_id: "order_does_not_exist" } } },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.handled).toBe(false);
  });

  it("200s on an event type we do not handle", async () => {
    const res = await postWebhook({ event: "invoice.paid", payload: {} });
    expect(res.status).toBe(200);
    expect(res.body.data.handled).toBe(false);
  });

  it("marks an order paid on payment.captured, and replaying it only marks paid once", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_hook`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);
    const event = {
      event: "payment.captured",
      payload: { payment: { entity: { id: `pay_${RUN_ID}_hook`, order_id: rzpOrderId } } },
    };

    const first = await postWebhook(event);
    expect(first.status).toBe(200);
    const afterFirst = await Order.findById(order._id).lean();
    expect(afterFirst!.paymentStatus).toBe("PAID");
    expect(afterFirst!.status).toBe("CONFIRMED");
    const paidAt = afterFirst!.payment!.paidAt!.toISOString();

    const second = await postWebhook(event);
    expect(second.status).toBe(200);
    const afterSecond = await Order.findById(order._id).lean();
    expect(afterSecond!.payment!.paidAt!.toISOString()).toBe(paidAt);
    expect(afterSecond!.statusHistory.filter((h) => h.status === "CONFIRMED")).toHaveLength(1);
  });

  it("cancels and restores stock on payment.failed", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_failed`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);
    const productId = order.items[0].productId;
    const before = (await Product.findById(productId).select("inventory").lean())!.inventory.stockQuantity;

    const res = await postWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: `pay_${RUN_ID}_failed`, order_id: rzpOrderId } } },
    });

    expect(res.status).toBe(200);
    const doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("FAILED");
    expect(doc!.status).toBe("CANCELLED");
    const after = (await Product.findById(productId).select("inventory").lean())!.inventory.stockQuantity;
    expect(after).toBe(before + order.items[0].quantity);
  });

  it("does not downgrade an already-PAID order on a late payment.failed", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_late`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);

    await postWebhook({
      event: "payment.captured",
      payload: { payment: { entity: { id: `pay_${RUN_ID}_late_ok`, order_id: rzpOrderId } } },
    });
    await postWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: `pay_${RUN_ID}_late_bad`, order_id: rzpOrderId } } },
    });

    const doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("PAID");
    expect(doc!.status).toBe("CONFIRMED");
  });

  it("records a refund on refund.processed", async () => {
    const user = await makeUser();
    const rzpOrderId = `order_${RUN_ID}_refund`;
    const paymentId = `pay_${RUN_ID}_refund`;
    const order = await makePendingRazorpayOrder(user, rzpOrderId);

    await postWebhook({
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId } } },
    });

    // Half of the ₹800 grand total, in paise as Razorpay sends it.
    const partial = await postWebhook({
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_1", payment_id: paymentId, amount: 40000 } } },
    });
    expect(partial.status).toBe(200);
    let doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("PARTIALLY_REFUNDED");
    expect(doc!.payment!.refundedAmount).toBe(400);

    const full = await postWebhook({
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_2", payment_id: paymentId, amount: 80000 } } },
    });
    expect(full.status).toBe(200);
    doc = await Order.findById(order._id).lean();
    expect(doc!.paymentStatus).toBe("REFUNDED");
    expect(doc!.payment!.refundedAmount).toBe(800);
  });
});
