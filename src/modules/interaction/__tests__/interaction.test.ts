import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { vi } from "vitest";
import { User, Media, Category, Brand, Product, UserInteractionEvent, Order } from "../../../database/models";
import { env } from "../../../config/env";
import { enqueue, flushBuffer, bufferStats, __resetBufferForTests } from "../interaction.buffer";
import { interactionTrackingService, reconcilePurchaseEvents } from "../interaction.tracking.service";
import type { PreparedEvent } from "../interaction.events";
import type { OrderStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { createProduct, updateProductById } from "../../product/product.service";
import type { CreateProductInput } from "../../product/product.validation";

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const orderIds: mongoose.Types.ObjectId[] = [];
let mediaId: mongoose.Types.ObjectId;
let categoryId: mongoose.Types.ObjectId;
let brandId: mongoose.Types.ObjectId;
let productId: string;
let seq = 0;

async function makeUser() {
  const user = await User.create({
    phone: `7${RUN_ID}${String(userIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
  });
  userIds.push(user._id);
  return user;
}
const cookie = (u: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(u)}`;
const evt = (over: Record<string, unknown> = {}) => ({
  eventId: `evt-${RUN_ID}-${seq++}-xxxxxxxx`,
  sessionId: `sess-${RUN_ID}-xxxxxxxx`,
  type: "product_view",
  productId,
  ...over,
});
const post = (u: InstanceType<typeof User>, events: unknown[]) =>
  request(app).post("/api/interactions").set("Cookie", cookie(u)).send({ events });

async function consenting() {
  const u = await makeUser();
  await request(app).put("/api/me/tracking-consent").set("Cookie", cookie(u)).send({ granted: true });
  return u;
}

beforeAll(async () => {
  // The feature is off by default; these tests exercise it switched on.
  env.interactionTrackingEnabled = true;
  await connectDatabase();
  const admin = await makeUser();
  const media = await Media.create({
    mediaType: "IMAGE",
    storageProvider: "local",
    storageKey: `images/interaction-test/${RUN_ID}`,
    originalName: "p.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: 100,
    status: "TEMPORARY",
    uploadedBy: admin._id,
  });
  mediaId = media._id;
  const category = await Category.create({ name: `IntCat-${RUN_ID}`, slug: `int-cat-${RUN_ID}`, isActive: true });
  categoryId = category._id;
  const brand = await Brand.create({ name: `IntBrand-${RUN_ID}`, slug: `int-brand-${RUN_ID}`, isActive: true });
  brandId = brand._id;
  const created = await createProduct({
    name: `Interaction Product ${RUN_ID}`,
    sku: `INT-SKU-${RUN_ID}`,
    shortDescription: "Short description.",
    description: "Longer detailed description of the product for the page.",
    categoryId: categoryId.toString(),
    brandId: brandId.toString(),
    mediaIds: [mediaId.toString()],
    pricing: { mrp: 500, sellingPrice: 400, costPrice: 250 },
    inventory: { stockQuantity: 20, lowStockThreshold: 5, trackInventory: true },
    seo: {
      title: "A properly sized SEO title for the product page",
      description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
      keywords: ["interaction test"],
    },
  } as CreateProductInput);
  productId = created!.productId;
  // Wishlist only accepts publicly visible products.
  await updateProductById(productId, { status: "ACTIVE" });
});

afterAll(async () => {
  await UserInteractionEvent.deleteMany({ userId: { $in: userIds } });
  await Order.deleteMany({ _id: { $in: orderIds } });
  await Product.deleteMany({ _id: productId });
  await Brand.deleteMany({ _id: brandId });
  await Category.deleteMany({ _id: categoryId });
  await Media.deleteMany({ _id: mediaId });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

describe("interaction ingestion", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/interactions").send({ events: [evt()] });
    expect(res.status).toBe(401);
  });

  it("records nothing until the user opts in", async () => {
    const u = await makeUser();
    const res = await post(u, [evt()]);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ tracking: "disabled", recorded: 0 });
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);
  });

  it("records a valid event for the session user and derives the category", async () => {
    const u = await consenting();
    const res = await post(u, [evt({ metadata: { surface: "search", position: 2 } })]);
    expect(res.body.data).toMatchObject({ tracking: "enabled", recorded: 1, duplicates: 0, rejected: 0 });
    const row = await UserInteractionEvent.findOne({ userId: u._id }).lean();
    expect(row?.categoryId?.toString()).toBe(categoryId.toString());
    expect(row?.consentVersion).toBe(1);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("ignores a client-supplied userId (identity comes from the session)", async () => {
    const u = await consenting();
    const other = await makeUser();
    const res = await post(u, [evt({ userId: other._id.toString() })]);
    expect(res.status).toBe(400);
    expect(await UserInteractionEvent.countDocuments({ userId: other._id })).toBe(0);
  });

  it("is idempotent on eventId", async () => {
    const u = await consenting();
    const e = evt();
    await post(u, [e]);
    const res = await post(u, [e]);
    expect(res.body.data).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(1);
  });

  it("rejects invalid payloads", async () => {
    const u = await consenting();
    expect((await post(u, [evt({ type: "nope" })])).status).toBe(400);
    expect((await post(u, [evt({ productId: undefined })])).status).toBe(400);
    expect((await post(u, [evt({ type: "search", productId: undefined })])).status).toBe(400);
    expect((await post(u, [evt({ metadata: { secret: "x" } })])).status).toBe(400);
    expect((await post(u, [evt({ query: "hi" })])).status).toBe(400);
    expect((await post(u, [])).status).toBe(400);
    expect((await post(u, Array.from({ length: 21 }, () => evt()))).status).toBe(400);
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);
  });

  it("sanitises search queries", async () => {
    const u = await consenting();
    await post(u, [evt({ type: "search", productId: undefined, query: "  dry\u0007  fruits \n box " })]);
    const row = await UserInteractionEvent.findOne({ userId: u._id }).lean();
    expect(row?.query).toBe("dry fruits box");
  });

  it("drops events for unknown products without failing the batch", async () => {
    const u = await consenting();
    const res = await post(u, [evt(), evt({ productId: new mongoose.Types.ObjectId().toString() })]);
    expect(res.body.data).toMatchObject({ recorded: 1, rejected: 1 });
  });
});

describe("consent, history and deletion", () => {
  it("history and deletion only ever touch the caller's own data", async () => {
    const a = await consenting();
    const b = await consenting();
    await post(a, [evt(), evt()]);
    await post(b, [evt()]);

    const hist = await request(app).get("/api/me/interaction-history").set("Cookie", cookie(a));
    expect(hist.body.data.total).toBe(2);
    expect(hist.body.data.items[0].userId).toBeUndefined();

    const del = await request(app).delete("/api/me/interaction-data").set("Cookie", cookie(a));
    expect(del.body.data.deleted).toBe(2);
    expect(await UserInteractionEvent.countDocuments({ userId: b._id })).toBe(1);
  });

  it("stops recording after consent is withdrawn", async () => {
    const u = await consenting();
    await request(app).put("/api/me/tracking-consent").set("Cookie", cookie(u)).send({ granted: false });
    const res = await post(u, [evt()]);
    expect(res.body.data.tracking).toBe("disabled");
  });

  it("delivers consent inside /auth/me so the storefront needs no extra request", async () => {
    const u = await makeUser();
    const before = await request(app).get("/api/auth/me").set("Cookie", cookie(u));
    expect(before.body.data.user.trackingConsent).toBeNull();
    await request(app).put("/api/me/tracking-consent").set("Cookie", cookie(u)).send({ granted: true });
    const after = await request(app).get("/api/auth/me").set("Cookie", cookie(u));
    expect(after.body.data.user.trackingConsent).toMatchObject({ granted: true });
  });

  it("defines the expected indexes", async () => {
    const idx = await UserInteractionEvent.collection.indexes();
    const byName = Object.fromEntries(idx.map((i) => [i.name, i]));
    expect(byName["userId_1_eventId_1"]?.unique).toBe(true);
    expect(byName["expiresAt_1"]?.expireAfterSeconds).toBe(0);
    expect(byName["userId_1_serverTs_-1"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Central tracking service, domain integration, buffering and recovery
// ---------------------------------------------------------------------------

async function makeOrder(
  userId: mongoose.Types.ObjectId,
  over: { status?: OrderStatus; paymentStatus?: "PENDING" | "PAID"; history?: OrderStatus[] } = {}
) {
  const product = await Product.findById(productId).lean();
  const status: OrderStatus = over.status ?? "CONFIRMED";
  const order = await Order.create({
    orderNumber: `ORD-INT-${RUN_ID}-${orderIds.length}`,
    userId,
    items: [
      {
        productId: product!._id,
        name: product!.name,
        sku: product!.sku,
        imageUrl: null,
        quantity: 2,
        unitPrice: 380,
        mrp: 500,
        discount: 120,
        discountPercentage: 24,
        lineTotal: 760,
      },
    ],
    pricing: { subtotal: 760, discountTotal: 0, shippingFee: 0, taxTotal: 0, grandTotal: 760 },
    shippingAddress: { city: "Mumbai", state: "Maharashtra", pincode: "400020", line1: "12" },
    status,
    paymentMethod: "COD",
    paymentStatus: over.paymentStatus ?? "PENDING",
    statusHistory: (over.history ?? [status]).map((st) => ({ status: st, at: new Date(), note: "test" })),
  });
  orderIds.push(order._id);
  return order;
}

const pe = (userId: string, i: number): PreparedEvent => ({
  userId,
  eventId: `bulk-${RUN_ID}-${i}-xxxxxxxx`,
  type: "wishlist_add",
  source: "server",
  productId,
  occurredAt: new Date(),
  consentVersion: 1,
});

describe("trust boundaries", () => {
  it("rejects server-authoritative types and server-owned fields from the browser", async () => {
    const u = await consenting();
    for (const type of ["wishlist_add", "wishlist_remove", "checkout_started", "purchase", "offer_accepted"]) {
      expect((await post(u, [evt({ type })])).status, type).toBe(400);
    }
    expect((await post(u, [evt({ displayedPrice: 1 })])).status).toBe(400);
    expect((await post(u, [evt({ orderId: new mongoose.Types.ObjectId().toString() })])).status).toBe(400);
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);
  });

  it("fills the price from the server catalog and marks browser events as client", async () => {
    const u = await consenting();
    await post(u, [evt()]);
    const row = await UserInteractionEvent.findOne({ userId: u._id }).lean();
    expect(row).toMatchObject({ source: "client", displayedPrice: 400, currency: "INR" });
    expect(row?.occurredAt).toBeInstanceOf(Date);
  });

  it("keeps legitimate repeated actions as separate events", async () => {
    const u = await consenting();
    await post(u, [evt({ type: "add_to_cart", quantity: 1 }), evt({ type: "add_to_cart", quantity: 1 })]);
    expect(await UserInteractionEvent.countDocuments({ userId: u._id, type: "add_to_cart" })).toBe(2);
  });
});

describe("server-side domain events", () => {
  it("records wishlist changes once, server-side, and only when state changed", async () => {
    const u = await consenting();
    const add = () => request(app).post(`/api/wishlist/${productId}`).set("Cookie", cookie(u));
    expect((await add()).status).toBe(200);
    await flushBuffer();
    expect((await add()).status).toBe(200); // already present: no new event
    await flushBuffer();
    expect(await UserInteractionEvent.countDocuments({ userId: u._id, type: "wishlist_add" })).toBe(1);

    await request(app).delete(`/api/wishlist/${productId}`).set("Cookie", cookie(u));
    await flushBuffer();
    const rows = await UserInteractionEvent.find({ userId: u._id }).lean();
    expect(rows.map((r) => r.type).sort()).toEqual(["wishlist_add", "wishlist_remove"]);
    expect(rows.every((r) => r.source === "server")).toBe(true);
    expect(rows[0].categoryId?.toString()).toBe(categoryId.toString());
    expect(rows.find((r) => r.type === "wishlist_add")?.displayedPrice).toBe(400);
  });

  it("records nothing without consent, and wishlist still works", async () => {
    const u = await makeUser();
    const res = await request(app).post(`/api/wishlist/${productId}`).set("Cookie", cookie(u));
    expect(res.status).toBe(200);
    await flushBuffer();
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);
  });

  it("never throws into the caller, even with a broken context", async () => {
    await expect(
      interactionTrackingService.track({ userId: "not-an-id" }, { type: "wishlist_add", productId })
    ).resolves.toBe(false);
    await expect(
      interactionTrackingService.track({ userId: userIds[0].toString(), consent: { granted: true } }, { type: "wishlist_add" })
    ).resolves.toBe(false); // violates the rule table (productId required)
  });
});

describe("purchase events", () => {
  it("records one deterministic event per order line, with server prices, exactly once", async () => {
    const u = await consenting();
    const order = await makeOrder(u._id);
    const first = await interactionTrackingService.trackPurchaseForOrder(order);
    const second = await interactionTrackingService.trackPurchaseForOrder(order);
    expect(first).toMatchObject({ ok: true, written: 1 });
    expect(second).toMatchObject({ ok: true, written: 0 });
    const row = await UserInteractionEvent.findOne({ userId: u._id, type: "purchase" }).lean();
    expect(row).toMatchObject({ source: "server", quantity: 2, displayedPrice: 380, currency: "INR" });
    expect(row?.orderId?.toString()).toBe(order._id.toString());
    expect(row?.eventId).toBe(`p-${order._id.toString()}-0`);
  });

  it("does not record purchases for users who had not consented at purchase time", async () => {
    const none = await makeUser();
    expect(await interactionTrackingService.trackPurchaseForOrder(await makeOrder(none._id))).toMatchObject({ written: 0 });

    const late = await consenting();
    const order = await makeOrder(late._id);
    await User.updateOne(
      { _id: late._id },
      { $set: { "trackingConsent.updatedAt": new Date(Date.now() + 60 * 60 * 1000) } }
    );
    expect(await interactionTrackingService.trackPurchaseForOrder(order)).toMatchObject({ written: 0 });
    expect(await UserInteractionEvent.countDocuments({ userId: late._id })).toBe(0);
  });

  it("the recovery sweep repairs a missed purchase and is idempotent", async () => {
    const u = await consenting();
    const confirmed = await makeOrder(u._id); // purchase event "lost"
    const pending = await makeOrder(u._id, { status: "PENDING_PAYMENT", history: ["PENDING_PAYMENT"] });
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);

    const run1 = await reconcilePurchaseEvents();
    expect(run1.written).toBeGreaterThanOrEqual(1);
    const rows = await UserInteractionEvent.find({ userId: u._id, type: "purchase" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId?.toString()).toBe(confirmed._id.toString()); // not the unpaid one
    expect(pending._id).toBeDefined();

    await reconcilePurchaseEvents();
    expect(await UserInteractionEvent.countDocuments({ userId: u._id, type: "purchase" })).toBe(1);
  });
});

describe("buffer: backpressure, failure handling, volume", () => {
  it("drops and counts events beyond the cap instead of growing without bound", async () => {
    __resetBufferForTests();
    const u = await makeUser();
    const original = env.interactionBufferMax;
    env.interactionBufferMax = 3;
    try {
      const accepted = [0, 1, 2, 3, 4].map((i) => enqueue(pe(u._id.toString(), i)));
      expect(accepted).toEqual([true, true, true, false, false]);
      expect(bufferStats()).toMatchObject({ accepted: 3, dropped: 2, bufferDepth: 3 });
      await flushBuffer();
      expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(3);
    } finally {
      env.interactionBufferMax = original;
    }
  });

  it("retries a failed flush, then drops the batch after repeated failures and keeps working", async () => {
    __resetBufferForTests();
    const u = await makeUser();
    const spy = vi.spyOn(UserInteractionEvent, "bulkWrite").mockRejectedValue(new Error("db down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      enqueue(pe(u._id.toString(), 100));
      await flushBuffer(); // failure 1: requeued
      expect(bufferStats()).toMatchObject({ flushFailures: 1, bufferDepth: 1, dropped: 0 });
      await flushBuffer(); // failure 2: requeued
      await flushBuffer(); // failure 3: dropped, counted
      expect(bufferStats()).toMatchObject({ flushFailures: 3, bufferDepth: 0, dropped: 1 });
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    enqueue(pe(u._id.toString(), 101)); // recovers once the DB is back
    await flushBuffer();
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(1);
  });

  it("withdrawing consent discards events still in the buffer", async () => {
    __resetBufferForTests();
    const u = await consenting();
    enqueue(pe(u._id.toString(), 200));
    await request(app).put("/api/me/tracking-consent").set("Cookie", cookie(u)).send({ granted: false });
    await flushBuffer();
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);
  });

  it("ingests a high-volume burst in a few batched writes", async () => {
    __resetBufferForTests();
    const u = await makeUser();
    const N = 2000;
    const spy = vi.spyOn(UserInteractionEvent, "bulkWrite");
    const t0 = Date.now();
    for (let i = 0; i < N; i++) enqueue(pe(u._id.toString(), 1000 + i));
    await flushBuffer();
    const ms = Date.now() - t0;
    console.log(`[interaction-test] ${N} events ingested in ${ms} ms using ${spy.mock.calls.length} bulkWrite call(s)`);
    spy.mockRestore();
    expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(N);
    expect(bufferStats().dropped).toBe(0);
  });
});

describe("monitoring access", () => {
  it("exposes ingestion stats to admins only", async () => {
    const u = await makeUser();
    expect((await request(app).get("/api/admin/interaction-stats").set("Cookie", cookie(u))).status).toBe(403);
    const admin = await makeUser();
    await User.updateOne({ _id: admin._id }, { $set: { role: "admin" } });
    const res = await request(app).get("/api/admin/interaction-stats").set("Cookie", cookie(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("bufferDepth");
    expect(res.body.data).toHaveProperty("dropped");
  });
});

describe("master switch (INTERACTION_TRACKING_ENABLED=false)", () => {
  it("records nothing anywhere, sweeps nothing, and hides consent from the storefront", async () => {
    const u = await consenting(); // opted in while the feature was on
    const order = await makeOrder(u._id);
    env.interactionTrackingEnabled = false;
    try {
      const ingest = await post(u, [evt()]);
      expect(ingest.status).toBe(202);
      expect(ingest.body.data).toMatchObject({ tracking: "disabled", recorded: 0 });

      expect((await request(app).post(`/api/wishlist/${productId}`).set("Cookie", cookie(u))).status).toBe(200);
      await flushBuffer();

      expect(await interactionTrackingService.track({ userId: u._id.toString(), consent: { granted: true } }, { type: "wishlist_add", productId })).toBe(false);
      expect(await interactionTrackingService.trackPurchaseForOrder(order)).toMatchObject({ written: 0 });
      expect(await reconcilePurchaseEvents()).toEqual({ orders: 0, written: 0 });
      expect(await UserInteractionEvent.countDocuments({ userId: u._id })).toBe(0);

      const me = await request(app).get("/api/auth/me").set("Cookie", cookie(u));
      expect(me.body.data.user).not.toHaveProperty("trackingConsent");
    } finally {
      env.interactionTrackingEnabled = true;
    }
  });
});
