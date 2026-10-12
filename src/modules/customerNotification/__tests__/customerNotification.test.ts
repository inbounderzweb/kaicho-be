import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";

// Order status changes also email the customer; keep that out of these tests.
vi.mock("../../../common/email/email.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/email/email.service")>()),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Order, type OrderStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { updateOrderStatusAdmin, cancelOrderForUser } from "../../order/order.service";
import { saveShipment } from "../../order/shipment.service";

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const orderIds: mongoose.Types.ObjectId[] = [];
let seq = 0;

async function makeUser() {
  const u = await User.create({
    phone: `5${RUN_ID}${String(userIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
  });
  userIds.push(u._id);
  return u;
}
const cookie = (u: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(u)}`;

async function makeOrder(userId: mongoose.Types.ObjectId, status: OrderStatus = "CONFIRMED") {
  const order = await Order.create({
    orderNumber: `ORD-CN-${RUN_ID}-${seq++}`,
    userId,
    items: [
      {
        // Non-existent product: cancelling restores stock, never touch a real one.
        productId: new mongoose.Types.ObjectId(),
        name: "Test product",
        sku: `CN-${RUN_ID}-${seq}`,
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
    statusHistory: [{ status, at: new Date(), note: "Order placed" }],
  });
  orderIds.push(order._id);
  return order;
}

const get = (u: InstanceType<typeof User>) => request(app).get("/api/notifications").set("Cookie", cookie(u));
const adminId = () => new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  await connectDatabase();
});
afterAll(async () => {
  await Order.deleteMany({ _id: { $in: orderIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

describe("customer order notifications", () => {
  it("requires login", async () => {
    expect((await request(app).get("/api/notifications")).status).toBe(401);
    expect((await request(app).post("/api/notifications/read")).status).toBe(401);
  });

  it("shows admin status updates, newest first, as unread", async () => {
    const u = await makeUser();
    const order = await makeOrder(u._id);
    expect((await get(u)).body.data).toEqual({ items: [], unreadCount: 0 }); // placing an order is not a notification

    await updateOrderStatusAdmin(order._id.toString(), adminId(), "PROCESSING");
    await saveShipment(order._id.toString(), adminId(), { carrier: "Delhivery", trackingNumber: "AWB123456789", status: "SHIPPED" });

    const { items, unreadCount } = (await get(u)).body.data;
    expect(unreadCount).toBe(items.length);
    expect(items[0]).toMatchObject({
      orderNumber: order.orderNumber,
      status: "SHIPPED",
      message: "has been shipped",
      unread: true,
      tracking: { carrier: "Delhivery", trackingNumber: "AWB123456789" },
    });
    expect(items.map((i: { status: string }) => i.status)).toContain("PROCESSING");
  });

  it("marking read clears the unread count, and later updates are unread again", async () => {
    const u = await makeUser();
    const order = await makeOrder(u._id);
    await updateOrderStatusAdmin(order._id.toString(), adminId(), "PROCESSING");
    expect((await get(u)).body.data.unreadCount).toBe(1);

    expect((await request(app).post("/api/notifications/read").set("Cookie", cookie(u))).status).toBe(200);
    const after = (await get(u)).body.data;
    expect(after.unreadCount).toBe(0);
    expect(after.items).toHaveLength(1); // still listed, just read

    await new Promise((r) => setTimeout(r, 20));
    await saveShipment(order._id.toString(), adminId(), { carrier: "DTDC", trackingNumber: "AWB987654321", status: "SHIPPED" });
    expect((await get(u)).body.data.unreadCount).toBe(1);
  });

  it("does not notify the customer about their own cancellation", async () => {
    const u = await makeUser();
    const order = await makeOrder(u._id);
    await cancelOrderForUser(u._id.toString(), order.orderNumber);
    expect((await get(u)).body.data).toEqual({ items: [], unreadCount: 0 });

    const other = await makeOrder(u._id);
    await updateOrderStatusAdmin(other._id.toString(), adminId(), "CANCELLED", "Out of stock");
    const items = (await get(u)).body.data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ orderNumber: other.orderNumber, status: "CANCELLED" });
  });

  it("only ever returns the caller's own orders", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await updateOrderStatusAdmin((await makeOrder(a._id))._id.toString(), adminId(), "PROCESSING");
    expect((await get(a)).body.data.items).toHaveLength(1);
    expect((await get(b)).body.data).toEqual({ items: [], unreadCount: 0 });
  });
});
