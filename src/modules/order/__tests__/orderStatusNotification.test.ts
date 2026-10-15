import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";

const sendEmail = vi.fn();
vi.mock("../../../common/email/email.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/email/email.service")>()),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

import { connectDatabase } from "../../../database/connection";
import { User, Order, type OrderStatus } from "../../../database/models";
import { updateOrderStatusAdmin } from "../order.service";
import { saveShipment, updateShipmentStatus } from "../shipment.service";

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
});
