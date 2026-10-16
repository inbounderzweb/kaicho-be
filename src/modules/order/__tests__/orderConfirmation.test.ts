import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import mongoose from "mongoose";

const { sendEmail, notifyAdminsNewOrder } = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  notifyAdminsNewOrder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../common/email/email.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/email/email.service")>()),
  sendEmail,
}));
vi.mock("../../notification/notification.service", () => ({ notifyAdminsNewOrder }));
vi.mock("../../../common/analytics/ga4", () => ({ trackServerPurchase: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../interaction/interaction.tracking.service", () => ({
  interactionTrackingService: {
    trackPurchaseForOrder: vi.fn().mockResolvedValue(undefined),
    trackCheckoutStarted: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../../common/payments/razorpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/payments/razorpay")>()),
  createRazorpayOrder: vi.fn().mockResolvedValue({ id: "order_confirmation_test", amount: 80000, currency: "INR" }),
}));

import { env } from "../../../config/env";
import { connectDatabase } from "../../../database/connection";
import { Order, Product, User } from "../../../database/models";
import { createCheckout } from "../../checkout/checkout.service";
import { handleWebhookEvent, verifyPayment } from "../../payment/payment.service";
import { listNotifications } from "../../customerNotification/customerNotification.service";
import { updateOrderStatusAdmin } from "../order.service";

// Explicit local test DB only. Never inherit a developer's Atlas/production
// database from .env just to run these integration tests.
const isolatedDatabase = /^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/kaicho_[\w-]*test(?:\?|$)/.test(process.env.MONGO_URI ?? "");
const suite = isolatedDatabase ? describe : describe.skip;
const run = new mongoose.Types.ObjectId().toString();
const userIds: mongoose.Types.ObjectId[] = [];
const productIds: mongoose.Types.ObjectId[] = [];
const secret = "confirmation-test-secret";

async function fixture() {
  const n = userIds.length;
  const user = await User.create({
    phone: `76${run.slice(-5)}${String(n).padStart(3, "0")}`,
    firstName: "Asha",
    email: `confirmation-${run}-${n}@example.com`,
    emailVerified: true,
    addresses: [{ line1: "12 Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020" }],
  });
  userIds.push(user._id);
  const product = await Product.create({
    name: "Confirmation product",
    slug: `confirmation-${run}-${n}`,
    sku: `CONF-${run}-${n}`,
    shortDescription: "Test product",
    description: "Test product for checkout confirmations",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1000, sellingPrice: 800 },
    inventory: { stockQuantity: 20, trackInventory: true },
    seo: { title: "Confirmation test", description: "Confirmation test product", keywords: [] },
    status: "ACTIVE",
  });
  productIds.push(product._id);
  return {
    user,
    input: { items: [{ productId: product._id.toString(), quantity: 1 }], addressId: user.addresses[0]._id!.toString() },
    key: `confirmation-${run}-${n}`,
  };
}

async function payment(orderId: string) {
  const razorpayOrderId = `order_${orderId}`;
  const razorpayPaymentId = `pay_${orderId}`;
  await Order.updateOne({ _id: orderId }, { $set: { "payment.razorpayOrderId": razorpayOrderId } });
  return {
    verify: {
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature: crypto.createHmac("sha256", secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex"),
    },
    event: { event: "payment.captured", payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } } },
  };
}

async function confirmationFor(email: string) {
  await vi.waitFor(() => expect(sendEmail.mock.calls.filter(([message]) => message.to === email)).toHaveLength(1));
  return sendEmail.mock.calls.find(([message]) => message.to === email)![0];
}

suite("customer confirmation delivery (isolated MongoDB)", () => {
  beforeAll(async () => {
    env.razorpayKeySecret = secret;
    await connectDatabase();
  });
  beforeEach(() => {
    sendEmail.mockClear();
    notifyAdminsNewOrder.mockClear();
  });
  afterAll(async () => {
    await Order.deleteMany({ userId: { $in: userIds } });
    await Product.deleteMany({ _id: { $in: productIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.connection.close();
  });

  it("emails a COD confirmation and creates a bell notification once, including checkout retries", async () => {
    const { user, input, key } = await fixture();
    const first = await createCheckout(user._id.toString(), { ...input, paymentMethod: "COD" }, key);
    const message = await confirmationFor(user.email!);
    expect(message.subject).toContain(`${first.order.orderNumber} is confirmed`);
    expect(message.text).toContain(`/orders/${first.order.orderNumber}`);
    expect(message.html).toContain("Thank you for your order");
    expect((await listNotifications(user._id.toString())).items).toEqual([
      expect.objectContaining({ status: "CONFIRMED", orderNumber: first.order.orderNumber, unread: true }),
    ]);

    const replay = await createCheckout(user._id.toString(), { ...input, paymentMethod: "COD" }, key);
    expect(replay.replayed).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(notifyAdminsNewOrder).toHaveBeenCalledTimes(1);
  });

  it.each(["verify-first", "webhook-first"])("waits for online payment and acknowledges only once with %s retries", async (mode) => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    expect(checkout.order.status).toBe("PENDING_PAYMENT");
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await listNotifications(user._id.toString())).items).toHaveLength(0);

    // Each test has a unique gateway id; the mocked gateway itself does not
    // make network requests and only checkout's stored id is verified.
    const payload = await payment(checkout.order.orderId);

    if (mode === "verify-first") await verifyPayment(user._id.toString(), payload.verify);
    else await handleWebhookEvent(payload.event);
    await confirmationFor(user.email!);

    await verifyPayment(user._id.toString(), payload.verify);
    await handleWebhookEvent(payload.event);
    await handleWebhookEvent(payload.event);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(notifyAdminsNewOrder).toHaveBeenCalledTimes(1);
    expect((await listNotifications(user._id.toString())).items).toHaveLength(1);
  });

  it("acknowledges one confirmation when browser verification and webhook arrive together", async () => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);

    await Promise.all([
      verifyPayment(user._id.toString(), payload.verify),
      handleWebhookEvent(payload.event),
    ]);
    await confirmationFor(user.email!);
    expect(notifyAdminsNewOrder).toHaveBeenCalledTimes(1);
    expect((await listNotifications(user._id.toString())).items).toHaveLength(1);
  });

  it("does not repeat an admin confirmation when payment is captured later", async () => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);
    await updateOrderStatusAdmin(checkout.order.orderId, undefined, "CONFIRMED");
    await confirmationFor(user.email!);

    const paid = await verifyPayment(user._id.toString(), payload.verify);
    await handleWebhookEvent(payload.event);
    expect(paid.order.paymentStatus).toBe("PAID");
    expect(paid.alreadyVerified).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await listNotifications(user._id.toString())).items).toHaveLength(1);
  });

  it.each(["REFUNDED", "PARTIALLY_REFUNDED"])("keeps %s payments settled when an old capture is retried", async (paymentStatus) => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);
    await handleWebhookEvent(payload.event);
    await confirmationFor(user.email!);
    sendEmail.mockClear();
    notifyAdminsNewOrder.mockClear();
    await Order.updateOne({ _id: checkout.order.orderId }, { $set: { paymentStatus } });

    const replay = await verifyPayment(user._id.toString(), payload.verify);
    await handleWebhookEvent(payload.event);
    expect(replay.alreadyVerified).toBe(true);
    expect(replay.order.paymentStatus).toBe(paymentStatus);
    expect((await Order.findById(checkout.order.orderId))!.paymentStatus).toBe(paymentStatus);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyAdminsNewOrder).not.toHaveBeenCalled();
  });

  it("records a late payment on a cancelled order without sending a confirmation", async () => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);
    await Order.updateOne({ _id: checkout.order.orderId }, { $set: { status: "CANCELLED" } });

    await handleWebhookEvent(payload.event);
    const doc = await Order.findById(checkout.order.orderId);
    expect(doc!.status).toBe("CANCELLED");
    expect(doc!.paymentStatus).toBe("PAID");
    expect(doc!.statusHistory.filter((entry) => entry.status === "CONFIRMED")).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyAdminsNewOrder).not.toHaveBeenCalled();
  });

  it("does not confirm or send an email for an invalid payment signature", async () => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);
    await expect(verifyPayment(user._id.toString(), { ...payload.verify, razorpaySignature: "0".repeat(64) }))
      .rejects.toThrow("Payment verification failed");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyAdminsNewOrder).not.toHaveBeenCalled();
    expect((await listNotifications(user._id.toString())).items).toHaveLength(0);
  });

  it("ignores a failure webhook whose pending read was overtaken by a captured payment", async () => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);
    const before = (await Product.findById(input.items[0].productId))!.inventory.stockQuantity;
    const stale = await Order.findById(checkout.order.orderId);

    // Pause the failure path after its read; allow capture to finish before
    // returning that stale pending document. No timing-dependent sleeps.
    const read = vi.spyOn(Order, "findOne").mockReturnValueOnce({
      exec: async () => {
        await handleWebhookEvent(payload.event);
        await confirmationFor(user.email!);
        return stale;
      },
    } as ReturnType<typeof Order.findOne>);
    try {
      await handleWebhookEvent({ ...payload.event, event: "payment.failed" });
    } finally {
      read.mockRestore();
    }

    const doc = await Order.findById(checkout.order.orderId);
    expect(doc!.paymentStatus).toBe("PAID");
    expect(doc!.status).toBe("CONFIRMED");
    expect((await Product.findById(input.items[0].productId))!.inventory.stockQuantity).toBe(before);
    expect(notifyAdminsNewOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps the order pending (stock still reserved) when duplicate failure webhooks arrive together", async () => {
    const { user, input, key } = await fixture();
    const checkout = await createCheckout(user._id.toString(), { ...input, paymentMethod: "RAZORPAY" }, key);
    const payload = await payment(checkout.order.orderId);
    const event = { ...payload.event, event: "payment.failed" };
    await Promise.all([handleWebhookEvent(event), handleWebhookEvent(event)]);

    // A failed attempt must not cancel the order: the customer can pay again.
    // Stock stays reserved (nothing restored, nothing restored twice) until the
    // order is paid, cancelled, or expired by the cleanup sweep.
    const doc = await Order.findById(checkout.order.orderId);
    expect(doc!.paymentStatus).toBe("PENDING");
    expect(doc!.status).toBe("PENDING_PAYMENT");
    expect(doc!.statusHistory.filter((entry) => entry.status === "CANCELLED")).toHaveLength(0);
    expect((await Product.findById(input.items[0].productId))!.inventory.stockQuantity).toBe(20 - input.items[0].quantity);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
