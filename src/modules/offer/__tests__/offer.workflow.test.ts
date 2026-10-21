import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import {
  User,
  Product,
  Category,
  Order,
  Coupon,
  CouponUsage,
  Offer,
  OfferUsage,
  OfferActivity,
  ProductStatus,
} from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { cancelStalePendingOrders } from "../../order/orderCleanup";
import { ensureOfferIndexes } from "../offer.indexes";
import { ensureCouponIndexes } from "../../coupon/coupon.indexes";

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const productIds: mongoose.Types.ObjectId[] = [];
const categoryIds: mongoose.Types.ObjectId[] = [];
const offerIds: mongoose.Types.ObjectId[] = [];
const couponIds: mongoose.Types.ObjectId[] = [];
let seq = 0;
let userSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `78${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  userIds.push(user._id);
  return user;
}
const cookie = (u: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(u)}`;

async function makeProduct(opts: { price?: number; stock?: number; status?: ProductStatus; categoryId?: mongoose.Types.ObjectId } = {}) {
  const n = seq++;
  const price = opts.price ?? 180;
  const p = await Product.create({
    name: `Offer Product ${RUN_ID}-${n}`,
    slug: `offer-product-${RUN_ID}-${n}`,
    sku: `OFR-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: opts.categoryId ?? new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: price + 100, sellingPrice: price },
    inventory: { stockQuantity: opts.stock ?? 50, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["offer"] },
    status: opts.status ?? "ACTIVE",
  });
  productIds.push(p._id);
  return p;
}

async function makeOffer(over: Record<string, unknown> = {}) {
  const o = await Offer.create({
    name: `BOGO ${RUN_ID}-${seq++}`,
    type: "BOGO",
    status: "ACTIVE",
    buyQuantity: 1,
    maxFreeUnitsPerOrder: 2,
    applyToAll: false,
    eligibleProductIds: [],
    ...over,
  });
  offerIds.push(o._id);
  return o;
}

async function makeCoupon(over: Record<string, unknown> = {}) {
  const c = await Coupon.create({
    code: `OFC${RUN_ID}${seq++}`,
    name: "Offer-test coupon",
    discountType: "PERCENTAGE",
    discountValue: 10,
    status: "ACTIVE",
    ...over,
  });
  couponIds.push(c._id);
  return c;
}

async function makeAddress(user: InstanceType<typeof User>): Promise<string> {
  const res = await request(app).post("/api/addresses").set("Cookie", cookie(user)).send({
    label: "Home",
    receiverName: "Asha Menon",
    receiverPhone: "9876543210",
    houseNo: "12",
    area: "Marine Drive",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400020",
  });
  return res.body.data.address.addressId;
}

const preview = (u: InstanceType<typeof User>, body: object) =>
  request(app).post("/api/checkout/preview").set("Cookie", cookie(u)).send(body);
const checkout = (u: InstanceType<typeof User>, body: object, key = `k-${RUN_ID}-${Math.random().toString(36).slice(2)}`) =>
  request(app).post("/api/checkout").set("Cookie", cookie(u)).set("Idempotency-Key", key).send(body);
const line = (p: { _id: mongoose.Types.ObjectId }, quantity: number) => ({ productId: p._id.toString(), quantity });

beforeAll(async () => {
  await connectDatabase();
  await ensureOfferIndexes();
  await ensureCouponIndexes();
});

// Offers are global and automatic, so a leftover ACTIVE offer from one test
// would bleed into the next. Disable everything this file created after each test.
afterEach(async () => {
  await Offer.updateMany({ _id: { $in: offerIds } }, { $set: { status: "DISABLED" } });
});

afterAll(async () => {
  await OfferUsage.deleteMany({ offerId: { $in: offerIds } });
  await OfferActivity.deleteMany({ offerId: { $in: offerIds } });
  await Offer.deleteMany({ _id: { $in: offerIds } });
  await CouponUsage.deleteMany({ couponId: { $in: couponIds } });
  await Coupon.deleteMany({ _id: { $in: couponIds } });
  await Order.deleteMany({ userId: { $in: userIds } });
  await Product.deleteMany({ _id: { $in: productIds } });
  await Category.deleteMany({ _id: { $in: categoryIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});


describe("workflow gaps: guest evaluate, invalid input, price change, deactivation, abandoned orders", () => {
  it("POST /offers/evaluate prices a cart for a GUEST with the offer, from DB prices", async () => {
    const a = await makeProduct({ price: 180 });
    const b = await makeProduct({ price: 150 });
    await makeOffer({ eligibleProductIds: [a._id, b._id] });
    const res = await request(app).post("/api/offers/evaluate").send({ items: [line(a, 1), line(b, 1)], unitPrice: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.pricing).toMatchObject({ subtotal: 330, offerDiscountTotal: 150 });
    expect(res.body.data.offer.eligibleProductIds.sort()).toEqual([a._id.toString(), b._id.toString()].sort());
  });

  it("evaluate never frees an out-of-stock or inactive item and rejects malformed ids", async () => {
    const a = await makeProduct({ price: 180 });
    const oos = await makeProduct({ price: 100, stock: 0 });
    const inactive = await makeProduct({ price: 100, status: "DRAFT" });
    await makeOffer({ eligibleProductIds: [a._id, oos._id, inactive._id] });
    const res = await request(app).post("/api/offers/evaluate").send({ items: [line(a, 1), line(oos, 1), line(inactive, 1)] });
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
    const bad = await request(app).post("/api/offers/evaluate").send({ items: [{ productId: "nope", quantity: 1 }] });
    expect(bad.status).toBe(400);
  });

  it("checkout with an unknown (but well-formed) product id fails cleanly and creates nothing", async () => {
    const user = await makeUser();
    const addressId = await makeAddress(user);
    const res = await checkout(user, { items: [{ productId: new mongoose.Types.ObjectId().toString(), quantity: 2 }], addressId, paymentMethod: "COD" });
    expect(res.status).toBe(409);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
  });

  it("a price change after the preview is caught (409) and the re-priced checkout then succeeds", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);
    const pv = await preview(user, { items: [line(p, 2)] });
    expect(pv.body.data.offer.discountAmount).toBe(100);

    await Product.updateOne({ _id: p._id }, { $set: { "pricing.sellingPrice": 120, "pricing.mrp": 200 } });
    const stale = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", expectedOfferDiscount: pv.body.data.offer.discountAmount });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ offerChanged: true, offerDiscount: 120 });
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);

    const ok = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", expectedOfferDiscount: 120 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.order.pricing).toMatchObject({ subtotal: 240, offerDiscountTotal: 120 });
  });

  it("deactivating the offer mid-flow: stale checkout is refused, a fresh one is full price", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    const offer = await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);
    await Offer.updateOne({ _id: offer._id }, { $set: { status: "DISABLED" } });

    const stale = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", expectedOfferDiscount: 100 });
    expect(stale.status).toBe(409);
    const fresh = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", expectedOfferDiscount: 0 });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.order.pricing.offerDiscountTotal).toBe(0);
    expect(fresh.body.data.order.offer).toBeNull();
    expect(await OfferUsage.countDocuments({ offerId: offer._id })).toBe(0);
  });

  it("an offer that expires between preview and checkout is not applied", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    const offer = await makeOffer({ eligibleProductIds: [p._id], endsAt: new Date(Date.now() + 86_400_000) });
    const addressId = await makeAddress(user);
    await Offer.updateOne({ _id: offer._id }, { $set: { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 86_400_000) } });
    const res = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD" });
    expect(res.status).toBe(201);
    expect(res.body.data.order.pricing.offerDiscountTotal).toBe(0);
  });

  it("an abandoned PENDING_PAYMENT order is swept: stock, offer redemption and usage row are released exactly once", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    const offer = await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);
    const res = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD" });
    expect(res.status).toBe(201);
    expect((await Offer.findById(offer._id))!.usedCount).toBe(1);

    // createdAt is immutable through Mongoose — age the order via the raw collection.
    await Order.collection.updateOne(
      { orderNumber: res.body.data.order.orderNumber },
      { $set: { status: "PENDING_PAYMENT", paymentStatus: "PENDING", createdAt: new Date(Date.now() - 3 * 3_600_000) } }
    );
    await cancelStalePendingOrders();
    await cancelStalePendingOrders(); // second sweep must be a no-op
    expect((await Offer.findById(offer._id))!.usedCount).toBe(0);
    expect(await OfferUsage.countDocuments({ offerId: offer._id })).toBe(0);
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(10);
  });

  it("two concurrent submits with the SAME idempotency key redeem the offer once", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    const offer = await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);
    const key = `dup-${RUN_ID}-${seq++}`;
    const body = { items: [line(p, 2)], addressId, paymentMethod: "COD" };
    const [r1, r2] = await Promise.all([checkout(user, body, key), checkout(user, body, key)]);
    expect([r1.status, r2.status].every((s) => s === 200 || s === 201)).toBe(true);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
    expect((await Offer.findById(offer._id))!.usedCount).toBe(1);
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(8);
  });
});
