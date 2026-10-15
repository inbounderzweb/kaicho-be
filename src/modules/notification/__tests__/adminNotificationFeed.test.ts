import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import request from "supertest";
import { Order, User, type OrderStatus } from "../../../database/models";
import { env } from "../../../config/env";
import { errorHandler } from "../../../common/middleware/errorHandler";
import router from "../notification.routes";

// Explicit local test DB only. Never inherit a developer's Atlas/production
// database from .env just to run these integration tests.
const isolatedDatabase = /^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/kaicho_[\w-]*test(?:\?|$)/.test(process.env.MONGO_URI ?? "");
const suite = isolatedDatabase ? describe : describe.skip;
const app = express();
app.use(express.json(), cookieParser());
app.use("/notifications", router);
app.use(errorHandler);
const userIds: mongoose.Types.ObjectId[] = [];
const orderIds: mongoose.Types.ObjectId[] = [];
let admin: Awaited<ReturnType<typeof User.create>>;
let customer: Awaited<ReturnType<typeof User.create>>;
let sequence = 0;
const cookie = (user: { id: string; tokenVersion: number }) => `${env.cookieName}=${jwt.sign({ sub: user.id, tv: user.tokenVersion }, env.jwtSecret)}`;
const get = () => request(app).get("/notifications").set("Cookie", cookie(admin));
const acknowledge = (orderIds: string[]) => request(app).post("/notifications/read").set("Cookie", cookie(admin)).send({ orderIds });

async function createOrder(confirmedAt: Date | null, options: { status?: OrderStatus; createdAt?: Date; repeatAt?: Date } = {}) {
  const order = await Order.create({
    orderNumber: `ADMIN-FEED-TEST-${Date.now()}-${sequence++}`,
    userId: customer._id,
    items: [{ productId: new mongoose.Types.ObjectId(), name: "Test", sku: "FEED-TEST", quantity: 1,
      unitPrice: 100, mrp: 100, discount: 0, discountPercentage: 0, lineTotal: 100 }],
    pricing: { subtotal: 100, discountTotal: 0, shippingFee: 0, taxTotal: 0, grandTotal: 100 },
    shippingAddress: { receiverName: "Receiver", city: "Mumbai", state: "MH", pincode: "400001", line1: "Test" },
    status: options.status ?? (confirmedAt ? "CONFIRMED" : "PENDING_PAYMENT"),
    paymentMethod: "RAZORPAY", paymentStatus: confirmedAt ? "PAID" : "PENDING",
    statusHistory: [
      { status: "PENDING_PAYMENT", at: options.createdAt ?? new Date() },
      ...(confirmedAt ? [{ status: "CONFIRMED", at: confirmedAt }] : []),
      ...(options.repeatAt ? [{ status: "CONFIRMED", at: options.repeatAt }] : []),
      ...(options.status ? [{ status: options.status, at: new Date() }] : []),
    ],
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  });
  orderIds.push(order._id);
  return order;
}

suite("durable admin new-order notifications (isolated MongoDB)", () => {
  beforeAll(async () => {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
    [admin, customer] = await User.create([
      { role: "admin", firstName: "Admin" },
      { role: "user", firstName: "Asha", lastName: "Patel" },
    ]);
    userIds.push(admin._id, customer._id);
  });
  beforeEach(async () => {
    await Order.deleteMany({ _id: { $in: orderIds } });
    await User.updateOne({ _id: admin._id }, { $unset: { notificationsSeenAt: 1 } });
  });
  afterAll(async () => {
    await Order.deleteMany({ _id: { $in: orderIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  });

  it("requires an admin for both history and read acknowledgements", async () => {
    expect((await request(app).get("/notifications")).status).toBe(401);
    expect((await request(app).post("/notifications/read").send({ orderIds: [] })).status).toBe(401);
    expect((await request(app).get("/notifications").set("Cookie", cookie(customer))).status).toBe(403);
    expect((await request(app).post("/notifications/read").set("Cookie", cookie(customer))).status).toBe(403);
  });

  it("recovers confirmed orders, excludes abandoned payments, and retains subsequently cancelled orders", async () => {
    const firstAt = new Date(Date.now() - 10_000);
    const lastAt = new Date(Date.now() - 1000);
    const first = await createOrder(firstAt);
    const last = await createOrder(lastAt, { status: "CANCELLED" });
    await createOrder(null);
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.data.unreadCount).toBe(2);
    expect(result.body.data.items.map((item: { orderId: string }) => item.orderId)).toEqual([last.id, first.id]);
    expect(result.body.data.items[0]).toMatchObject({
      id: last.id, customerName: "Asha Patel", amount: 100, itemsCount: 1, unread: true,
      confirmedAt: lastAt.toISOString(),
    });
  });

  it("uses confirmation time rather than checkout creation time, with a bounded 30-day history", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 1000);
    const delayedPayment = await createOrder(recent, { createdAt: old });
    await createOrder(old, { createdAt: old, repeatAt: recent });
    const items = (await get()).body.data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ orderId: delayedPayment.id, createdAt: old.toISOString(), confirmedAt: recent.toISOString() });
  });

  it("persists read state across sessions without changing customer notification reads", async () => {
    const order = await createOrder(new Date(Date.now() - 10_000));
    const updatedAt = order.updatedAt.toISOString();
    const first = (await get()).body.data;
    expect((await acknowledge(first.items.map((item: { orderId: string }) => item.orderId))).status).toBe(200);
    const next = (await get()).body.data;
    expect(next.unreadCount).toBe(0);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].unread).toBe(false);
    expect((await User.findById(admin._id).lean())?.notificationsSeenAt).toBeUndefined();
    expect((await Order.findById(order._id).lean())?.updatedAt.toISOString()).toBe(updatedAt);
    const otherAdmin = await User.create({ role: "admin", firstName: "Other" });
    userIds.push(otherAdmin._id);
    const otherFeed = await request(app).get("/notifications").set("Cookie", cookie(otherAdmin));
    expect(otherFeed.body.data.unreadCount).toBe(1);
  });

  it("leaves an unseen delayed confirmation unread even with the same timestamp as an acknowledged order", async () => {
    const confirmedAt = new Date(Date.now() - 10_000);
    const earlier = await createOrder(confirmedAt);
    const delayed = await createOrder(null);
    const first = (await get()).body.data;
    expect(first.items.map((item: { orderId: string }) => item.orderId)).toEqual([earlier.id]);
    expect((await acknowledge([earlier.id])).status).toBe(200);
    // Emulate a payment write that commits after the read snapshot but used
    // a confirmation timestamp allocated before that snapshot.
    await Order.updateOne({ _id: delayed._id }, {
      $set: { status: "CONFIRMED", paymentStatus: "PAID" },
      $push: { statusHistory: { status: "CONFIRMED", at: confirmedAt } },
    });
    const result = (await get()).body.data;
    expect(result.unreadCount).toBe(1);
    expect(result.items.find((item: { orderId: string }) => item.orderId === delayed.id).unread).toBe(true);
    // A retry from an older tab acknowledges only its own observed IDs.
    expect((await acknowledge([earlier.id])).status).toBe(200);
    expect((await get()).body.data.unreadCount).toBe(1);
    expect((await Order.findById(earlier._id).lean())?.adminNotificationReadBy).toHaveLength(1);
  });

  it("bounds the unread count to the 20 displayed orders", async () => {
    for (let index = 0; index < 23; index += 1) await createOrder(new Date(Date.now() - 1000));
    const result = (await get()).body.data;
    expect(result.items).toHaveLength(20);
    expect(result.unreadCount).toBe(20);
    expect((await acknowledge(result.items.map((item: { orderId: string }) => item.orderId))).status).toBe(200);
    expect((await get()).body.data.unreadCount).toBe(0);
  });

  it("rejects malformed, empty, or oversized acknowledgement lists", async () => {
    expect((await acknowledge(["invalid"])).status).toBe(400);
    expect((await acknowledge([])).status).toBe(400);
    expect((await acknowledge(Array.from({ length: 21 }, () => new mongoose.Types.ObjectId().toString()))).status).toBe(400);
    expect((await request(app).post("/notifications/read").set("Cookie", cookie(admin)).send({ through: new Date().toISOString() })).status).toBe(400);
  });
});
