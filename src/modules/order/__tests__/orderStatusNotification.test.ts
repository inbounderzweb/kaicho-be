import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";

const sendEmail = vi.fn();
vi.mock("../../../common/email/email.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/email/email.service")>()),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

import { connectDatabase } from "../../../database/connection";
import { User, Order, type OrderStatus } from "../../../database/models";
import { updateOrderStatusAdmin as updateOrderStatusRaw, resendOrderStatusEmailAdmin } from "../order.service";
import { saveShipment as saveShipmentRaw, updateShipmentStatus as updateShipmentStatusRaw } from "../shipment.service";
import { updateOrderStatusSchema, saveShipmentSchema, updateShipmentStatusSchema } from "../order.validation";

// An admin's update only emails when it explicitly asks to, so the tests of the
// emails themselves go through these "Save & Send Email" shorthands. The
// consent rules (default = silent, retries, duplicates) use the raw functions
// in the "email consent" block below.
const updateOrderStatusAdmin = (id: string, actor: string | undefined, status: OrderStatus, note?: string) =>
  updateOrderStatusRaw(id, actor, status, note, true);
const saveShipment = (id: string, actor: string | undefined, input: Parameters<typeof saveShipmentRaw>[2]) =>
  saveShipmentRaw(id, actor, input, true);
const updateShipmentStatus = (id: string, actor: string | undefined, status: Parameters<typeof updateShipmentStatusRaw>[2], note?: string) =>
  updateShipmentStatusRaw(id, actor, status, note, true);

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const orderIds: mongoose.Types.ObjectId[] = [];
let seq = 0;

// Emails are sent in the background. Positive checks wait for the call to
// arrive (a fixed sleep is flaky against a remote DB); negative checks have to
// wait out a generous window to be meaningful.
const settle = () => new Promise((r) => setTimeout(r, 900));
const waitForEmails = (n: number) =>
  vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(n), { timeout: 5000, interval: 25 });

async function makeCustomer(over: { email?: string; emailVerified?: boolean } = {}) {
  const u = await User.create({
    phone: `6${RUN_ID}${String(userIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
    firstName: "Asha",
    lastName: "Rao",
    ...("email" in over ? { email: over.email } : { email: `cust-${RUN_ID}-${seq}@example.com` }),
    emailVerified: over.emailVerified ?? true,
  });
  userIds.push(u._id);
  return u;
}

async function makeOrder(userId: mongoose.Types.ObjectId, status: OrderStatus = "CONFIRMED") {
  // A product id that exists nowhere: cancelling restores stock, and these
  // tests must never touch a real product's inventory.
  const productId = new mongoose.Types.ObjectId();
  const order = await Order.create({
    orderNumber: `ORD-NOTIF-${RUN_ID}-${seq++}`,
    userId,
    items: [
      {
        productId,
        name: "Test product",
        sku: `NOTIF-${RUN_ID}-${seq}`,
        imageUrl: null,
        quantity: 1,
        unitPrice: 100,
        mrp: 120,
        discount: 20,
        discountPercentage: 16,
        lineTotal: 100,
      },
    ],
    pricing: { subtotal: 100, discountTotal: 0, shippingFee: 0, taxTotal: 0, grandTotal: 100 },
    shippingAddress: { city: "Mumbai", state: "Maharashtra", pincode: "400020", line1: "12" },
    status,
    paymentMethod: "COD",
    paymentStatus: "PENDING",
    statusHistory: [{ status, at: new Date(), note: "test" }],
  });
  orderIds.push(order._id);
  return order;
}

beforeAll(async () => {
  await connectDatabase();
});
beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
});
afterAll(async () => {
  await Order.deleteMany({ _id: { $in: orderIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

describe("order status emails", () => {
  it("emails the customer when an admin moves the order to PROCESSING", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    await updateOrderStatusAdmin(order._id.toString(), undefined, "PROCESSING");
    await waitForEmails(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe(u.email);
    expect(mail.subject).toContain(order.orderNumber);
    expect(mail.subject).toContain("prepared");
    expect(mail.html).toContain(`/orders/${order.orderNumber}`);
  });

  it("includes courier and tracking details once, when a shipment moves the order several steps at once", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id, "CONFIRMED"); // CONFIRMED -> PROCESSING -> SHIPPED in one save
    await saveShipment(order._id.toString(), undefined, {
      carrier: "Delhivery",
      trackingNumber: "AWB123456789",
      trackingUrl: "https://track.example.com/AWB123456789",
      status: "SHIPPED",
    });
    await waitForEmails(1);
    await settle(); // and nothing further arrives: one email for the final status, not two
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.subject).toContain("shipped");
    expect(mail.text).toContain("Delhivery");
    expect(mail.text).toContain("AWB123456789");
    expect(mail.html).toContain("https://track.example.com/AWB123456789");
  });

  it("does not email when only shipment details change, and drops non-http tracking links", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id, "PROCESSING");
    await saveShipment(order._id.toString(), undefined, {
      carrier: "DTDC",
      trackingNumber: "AWB987654321",
      trackingUrl: "javascript:alert(1)",
      status: "SHIPPED",
    });
    await waitForEmails(1);
    expect(sendEmail.mock.calls[0][0].html).not.toContain("javascript:");
    sendEmail.mockClear();
    await saveShipment(order._id.toString(), undefined, { trackingNumber: "AWB987654322" }); // typo fix
    await settle();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("emails for delivery via the quick shipment-status update", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id, "PROCESSING");
    await saveShipment(order._id.toString(), undefined, { carrier: "DTDC", trackingNumber: "AWB555555555", status: "SHIPPED" });
    await waitForEmails(1);
    sendEmail.mockClear();
    await updateShipmentStatus(order._id.toString(), undefined, "OUT_FOR_DELIVERY");
    await updateShipmentStatus(order._id.toString(), undefined, "DELIVERED");
    await waitForEmails(2);
    const subjects: string[] = sendEmail.mock.calls.map((c) => c[0].subject);
    expect(subjects).toHaveLength(2);
    expect(subjects[0]).toContain("out for delivery");
    expect(subjects[1]).toContain("delivered");
  });

  it("emails on admin cancellation", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    await updateOrderStatusAdmin(order._id.toString(), undefined, "CANCELLED", "Out of stock");
    await waitForEmails(1);
    expect(sendEmail.mock.calls[0][0].subject).toContain("cancelled");
  });

  it("emails an order confirmation when an admin confirms a pending order", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id, "PENDING_PAYMENT");
    await updateOrderStatusAdmin(order._id.toString(), undefined, "CONFIRMED");
    await waitForEmails(1);
    expect(sendEmail.mock.calls[0][0].subject).toContain("is confirmed");
    expect(sendEmail.mock.calls[0][0].text).toContain(order.orderNumber);
  });

  it("skips customers with no email or an unverified one", async () => {
    const noEmail = await makeCustomer({ email: undefined });
    const unverified = await makeCustomer({ emailVerified: false });
    await updateOrderStatusAdmin((await makeOrder(noEmail._id))._id.toString(), undefined, "PROCESSING");
    await updateOrderStatusAdmin((await makeOrder(unverified._id))._id.toString(), undefined, "PROCESSING");
    await settle();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never blocks or fails the admin update when the email fails", async () => {
    sendEmail.mockRejectedValue(new Error("smtp down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    const result = await updateOrderStatusAdmin(order._id.toString(), undefined, "PROCESSING");
    await waitForEmails(1);
    quiet.mockRestore();
    expect(result.status).toBe("PROCESSING");
    expect((await Order.findById(order._id).lean())!.status).toBe("PROCESSING");
  });

  describe("reports the email outcome to the admin", () => {
    // Braces matter: a returned function is run by vitest as a teardown hook.
    beforeEach(() => {
      sendEmail.mockResolvedValue(undefined);
    });

    it("sent: the response says the customer was emailed (and the mail was sent before the response)", async () => {
      const u = await makeCustomer();
      const order = await makeOrder(u._id);
      const result = await updateOrderStatusAdmin(order._id.toString(), undefined, "PROCESSING");
      expect(result.emailNotification.state).toBe("sent");
      // Awaited inside the request, not left to a background task.
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("skipped: explains a missing or unverified customer email", async () => {
      const noEmail = await makeCustomer({ email: undefined });
      const unverified = await makeCustomer({ emailVerified: false });
      const a = await updateOrderStatusAdmin((await makeOrder(noEmail._id))._id.toString(), undefined, "PROCESSING");
      const b = await updateOrderStatusAdmin((await makeOrder(unverified._id))._id.toString(), undefined, "PROCESSING");
      expect(a.emailNotification).toMatchObject({ state: "skipped", message: expect.stringMatching(/no email address/i) });
      expect(b.emailNotification).toMatchObject({ state: "skipped", message: expect.stringMatching(/isn't verified/i) });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("failed: the update still succeeds and the failure is reported", async () => {
      sendEmail.mockRejectedValue(new Error("smtp down"));
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const u = await makeCustomer();
      const order = await makeOrder(u._id);
      const result = await updateOrderStatusAdmin(order._id.toString(), undefined, "PROCESSING");
      quiet.mockRestore();
      expect(result.status).toBe("PROCESSING");
      expect(result.emailNotification).toMatchObject({ state: "failed", message: expect.stringMatching(/could not be sent/i) });
    });

    it("not_applicable: a change we don't email about", async () => {
      const u = await makeCustomer();
      const order = await makeOrder(u._id, "CONFIRMED");
      await Order.updateOne({ _id: order._id }, { $set: { status: "RETURN_REQUESTED" } });
      const result = await updateOrderStatusAdmin(order._id.toString(), undefined, "DELIVERED");
      // DELIVERED is emailed; RETURN_REQUESTED->DELIVERED is the "return rejected" path.
      expect(["sent", "not_applicable"]).toContain(result.emailNotification.state);
    });
  });
});


describe("email consent (admin chooses whether the customer is emailed)", () => {
  beforeEach(() => {
    sendEmail.mockResolvedValue(undefined);
  });

  it("Save & Send Email: updates the record and sends exactly one email", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    const result = await updateOrderStatusRaw(order._id.toString(), undefined, "PROCESSING", undefined, true);
    expect(result.status).toBe("PROCESSING");
    expect(result.emailNotification.state).toBe("sent");
    expect((await Order.findById(order._id).lean())!.status).toBe("PROCESSING");
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("Save Without Email: updates the record and sends nothing (status, shipment and shipment-status endpoints)", async () => {
    const u = await makeCustomer();
    const a = await makeOrder(u._id);
    const r1 = await updateOrderStatusRaw(a._id.toString(), undefined, "PROCESSING", undefined, false);
    expect(r1.status).toBe("PROCESSING");
    expect(r1.emailNotification).toMatchObject({ state: "not_requested" });

    const b = await makeOrder(u._id, "PROCESSING");
    const r2 = await saveShipmentRaw(b._id.toString(), undefined, { carrier: "DTDC", trackingNumber: "AWB111111111", status: "SHIPPED" }, false);
    expect(r2.status).toBe("SHIPPED");
    expect(r2.emailNotification.state).toBe("not_requested");
    const r3 = await updateShipmentStatusRaw(b._id.toString(), undefined, "DELIVERED", undefined, false);
    expect(r3.status).toBe("DELIVERED");
    expect(r3.emailNotification.state).toBe("not_requested");

    await settle();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("omitting the preference defaults to no email", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    const result = await updateOrderStatusRaw(order._id.toString(), undefined, "PROCESSING");
    expect(result.emailNotification.state).toBe("not_requested");
    await settle();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a missing, misspelt or wrongly-typed sendEmail parses to false; only a literal true sends", () => {
    const parse = (v: unknown) => updateOrderStatusSchema.parse({ status: "PROCESSING", ...(v === undefined ? {} : { sendEmail: v }) }).sendEmail;
    expect(parse(undefined)).toBe(false);
    for (const bad of ["true", "yes", 1, "1", null, {}, [], 0, "false", false]) expect(parse(bad)).toBe(false);
    expect(parse(true)).toBe(true);

    expect(saveShipmentSchema.parse({ carrier: "DTDC", sendEmail: "true" }).sendEmail).toBe(false);
    expect(saveShipmentSchema.parse({ carrier: "DTDC", sendEmail: true }).sendEmail).toBe(true);
    expect(updateShipmentStatusSchema.parse({ status: "DELIVERED", sendEmail: 1 }).sendEmail).toBe(false);
    // sendEmail alone isn't a shipment change.
    expect(saveShipmentSchema.safeParse({ sendEmail: true }).success).toBe(false);
  });

  it("a failed update (invalid transition / unknown order) sends no email", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id, "CONFIRMED");
    await expect(updateOrderStatusRaw(order._id.toString(), undefined, "DELIVERED", undefined, true)).rejects.toThrow(/Cannot move/);
    await expect(updateOrderStatusRaw(new mongoose.Types.ObjectId().toString(), undefined, "PROCESSING", undefined, true)).rejects.toThrow(/not found/i);
    await expect(saveShipmentRaw(order._id.toString(), undefined, { status: "SHIPPED" }, true)).rejects.toThrow(/Courier name/);
    await settle();
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await Order.findById(order._id).lean())!.status).toBe("CONFIRMED");
  });

  it("an email failure after a successful save is reported as 'failed', the update stands, and a retry sends exactly once", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    const id = order._id.toString();

    const saved = await updateOrderStatusRaw(id, undefined, "PROCESSING", undefined, true);
    expect(saved.status).toBe("PROCESSING");
    expect(saved.emailNotification.state).toBe("failed");
    expect((await Order.findById(order._id).lean())!.status).toBe("PROCESSING");

    const retried = await resendOrderStatusEmailAdmin(id);
    expect(retried.emailNotification.state).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(2); // the failed attempt + the retry

    const again = await resendOrderStatusEmailAdmin(id);
    expect(again.emailNotification.state).toBe("skipped"); // already delivered
    expect(sendEmail).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it("double-clicks and concurrent retries never create a duplicate email", async () => {
    const u = await makeCustomer();
    const order = await makeOrder(u._id);
    const id = order._id.toString();
    // Two identical requests racing (a double click): both pass validation and save.
    await Promise.allSettled([
      updateOrderStatusRaw(id, undefined, "PROCESSING", undefined, true),
      updateOrderStatusRaw(id, undefined, "PROCESSING", undefined, true),
    ]);
    await Promise.all([resendOrderStatusEmailAdmin(id), resendOrderStatusEmailAdmin(id), resendOrderStatusEmailAdmin(id)]);
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a skipped send (unverified address) releases its claim so a later retry can succeed", async () => {
    const u = await makeCustomer({ emailVerified: false });
    const order = await makeOrder(u._id);
    const id = order._id.toString();
    const first = await updateOrderStatusRaw(id, undefined, "PROCESSING", undefined, true);
    expect(first.emailNotification.state).toBe("skipped");
    await User.updateOne({ _id: u._id }, { $set: { emailVerified: true } });
    const retry = await resendOrderStatusEmailAdmin(id);
    expect(retry.emailNotification.state).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
