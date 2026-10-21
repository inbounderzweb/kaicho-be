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
import { computeOrderTotals } from "../../checkout/checkout.service";
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

describe("computeOrderTotals with an offer discount", () => {
  it("takes the offer off before the coupon and never goes negative", () => {
    const t = computeOrderTotals([360], undefined, { discountAmount: 1000, freeDelivery: false }, 180);
    expect(t.offerDiscountTotal).toBe(180);
    expect(t.discountTotal).toBe(180); // coupon clamped to what is left payable
    expect(t.grandTotal).toBe(49); // 360 - 180 - 180 = 0 + flat shipping (subtotal < 499 threshold)
  });
  it("is unchanged when no offer is passed (back-compat)", () => {
    expect(computeOrderTotals([100, 50])).toMatchObject({ subtotal: 150, offerDiscountTotal: 0 });
  });
});

describe("checkout preview with a BOGO offer", () => {
  it("makes the cheaper of two eligible units free and totals correctly", async () => {
    const user = await makeUser();
    const a = await makeProduct({ price: 180 });
    const b = await makeProduct({ price: 150 });
    await makeOffer({ eligibleProductIds: [a._id, b._id] });

    const res = await preview(user, { items: [line(a, 1), line(b, 1)] });
    expect(res.status).toBe(200);
    expect(res.body.data.offer.applied).toBe(true);
    expect(res.body.data.offer.discountAmount).toBe(150);
    expect(res.body.data.pricing).toMatchObject({ subtotal: 330, offerDiscountTotal: 150 });
    const items = res.body.data.items;
    expect(items.find((i: { productId: string }) => i.productId === b._id.toString()).freeQuantity).toBe(1);
    expect(items.find((i: { productId: string }) => i.productId === a._id.toString()).freeQuantity).toBe(0);
  });

  it("never gives a higher-priced selected item for free (rejects with a reason, keeps it paid)", async () => {
    const user = await makeUser();
    const cheap = await makeProduct({ price: 180 });
    const dear = await makeProduct({ price: 250 });
    await makeOffer({ eligibleProductIds: [cheap._id, dear._id] });

    const res = await preview(user, {
      items: [line(cheap, 1), line(dear, 1)],
      freeSelections: [{ productId: dear._id.toString(), quantity: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.offer.applied).toBe(false);
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
    expect(res.body.data.pricing.subtotal).toBe(430);
    expect(res.body.data.offer.rejected[0]).toMatchObject({ productId: dear._id.toString(), reason: "PRICE_TOO_HIGH" });
  });

  it("does not apply to ineligible products", async () => {
    const user = await makeUser();
    const eligible = await makeProduct({ price: 100 });
    const other = await makeProduct({ price: 100 });
    await makeOffer({ eligibleProductIds: [eligible._id] });

    const res = await preview(user, { items: [line(other, 2)] });
    expect(res.body.data.offer).toBeNull();
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("exclusions beat inclusion", async () => {
    const user = await makeUser();
    const a = await makeProduct({ price: 100 });
    await makeOffer({ eligibleProductIds: [a._id], excludedProductIds: [a._id] });
    const res = await preview(user, { items: [line(a, 2)] });
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("a legacy applyToAll offer no longer covers every product", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100 });
    await makeOffer({ applyToAll: true, eligibleProductIds: [new mongoose.Types.ObjectId()] }); // someone else's product only
    const res = await preview(user, { items: [line(p, 2)] });
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("a category selection never badges or discounts products you didn't pick", async () => {
    const user = await makeUser();
    const parent = await Category.create({ name: `Parent ${RUN_ID}`, slug: `parent-${RUN_ID}` });
    categoryIds.push(parent._id);
    const picked = await makeProduct({ price: 100, categoryId: parent._id });
    const sibling = await makeProduct({ price: 100, categoryId: parent._id });
    await makeOffer({ eligibleProductIds: [picked._id], eligibleCategoryIds: [parent._id] });
    expect((await preview(user, { items: [line(sibling, 2)] })).body.data.pricing.offerDiscountTotal).toBe(0);
    expect((await preview(user, { items: [line(picked, 2)] })).body.data.pricing.offerDiscountTotal).toBe(100);
    const pub = await request(app).get("/api/offers/active");
    const o = pub.body.data.offers.find((x: { eligibleProductIds: string[] }) => x.eligibleProductIds.includes(picked._id.toString()));
    expect(o.eligibleCategoryIds).toEqual([]);
  });

  it("enforces the free-unit cap", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100 });
    await makeOffer({ eligibleProductIds: [p._id], maxFreeUnitsPerOrder: 2 });
    const res = await preview(user, { items: [line(p, 6)] }); // 3 pairs possible, cap 2
    expect(res.body.data.offer.freeUnits).toBe(2);
    expect(res.body.data.offer.limitReached).toBe(true);
    expect(res.body.data.pricing.offerDiscountTotal).toBe(200);
  });

  it("enforces the start and end dates", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100 });
    const day = 86_400_000;
    await makeOffer({ eligibleProductIds: [p._id], startsAt: new Date(Date.now() + day) }); // not started
    await makeOffer({ eligibleProductIds: [p._id], endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - day) }); // ended
    await makeOffer({ eligibleProductIds: [p._id], status: "DISABLED" });
    await makeOffer({ eligibleProductIds: [p._id], status: "DRAFT" });
    const res = await preview(user, { items: [line(p, 2)] });
    expect(res.body.data.offer).toBeNull();
  });

  it("an out-of-stock item can't take part (so can't be the free one)", async () => {
    const user = await makeUser();
    const inStock = await makeProduct({ price: 180, stock: 5 });
    const oos = await makeProduct({ price: 100, stock: 0 });
    await makeOffer({ eligibleProductIds: [inStock._id, oos._id] });
    const res = await preview(user, {
      items: [line(inStock, 1), line(oos, 1)],
      freeSelections: [{ productId: oos._id.toString(), quantity: 1 }],
    });
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
    expect(res.body.data.items.find((i: { productId: string }) => i.productId === oos._id.toString()).freeQuantity).toBe(0);
  });

  it("applies the minimum purchased price", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100 });
    await makeOffer({ eligibleProductIds: [p._id], minPaidUnitPrice: 150 });
    const res = await preview(user, { items: [line(p, 2)] });
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("ignores any client-supplied price or discount fields", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100 });
    await makeOffer({ eligibleProductIds: [p._id] });
    const res = await preview(user, {
      items: [{ ...line(p, 2), unitPrice: 1, price: 1 }],
      offerDiscount: 9999,
      discountAmount: 9999,
    });
    expect(res.body.data.pricing.subtotal).toBe(200);
    expect(res.body.data.pricing.offerDiscountTotal).toBe(100);
  });
});

describe("coupon / offer stacking", () => {
  it("blocks a coupon when the offer doesn't allow stacking (preview reports it, checkout refuses)", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 300, stock: 10 });
    await makeOffer({ eligibleProductIds: [p._id], allowCouponStacking: false });
    const coupon = await makeCoupon();
    const addressId = await makeAddress(user);

    const pv = await preview(user, { items: [line(p, 2)], couponCode: coupon.code });
    expect(pv.body.data.coupon).toBeNull();
    expect(pv.body.data.couponError).toMatch(/can't be combined/i);
    expect(pv.body.data.pricing.offerDiscountTotal).toBe(300);

    const res = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", couponCode: coupon.code });
    expect(res.status).toBe(409);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(10); // stock released
  });

  it("when stacking is allowed the coupon discounts only what is left payable", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 300, stock: 10 });
    await makeOffer({ eligibleProductIds: [p._id], allowCouponStacking: true });
    const coupon = await makeCoupon({ discountType: "PERCENTAGE", discountValue: 10 });
    const addressId = await makeAddress(user);

    const res = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", couponCode: coupon.code });
    expect(res.status).toBe(201);
    const pricing = res.body.data.order.pricing;
    expect(pricing.subtotal).toBe(600);
    expect(pricing.offerDiscountTotal).toBe(300);
    expect(pricing.discountTotal).toBe(30); // 10% of (600 - 300)
    expect(pricing.grandTotal).toBe(270); // free shipping: pre-discount subtotal 600 >= threshold
  });
});

describe("checkout with a BOGO offer (COD)", () => {
  it("persists the free units, a full snapshot and a usage row; preview, checkout and order totals agree", async () => {
    const user = await makeUser();
    const a = await makeProduct({ price: 180, stock: 20 });
    const b = await makeProduct({ price: 150, stock: 20 });
    const offer = await makeOffer({ eligibleProductIds: [a._id, b._id] });
    const addressId = await makeAddress(user);
    const items = [line(a, 1), line(b, 1)];

    const pv = await preview(user, { items });
    const res = await checkout(user, {
      items,
      addressId,
      paymentMethod: "COD",
      expectedOfferDiscount: pv.body.data.offer.discountAmount,
    });
    expect(res.status).toBe(201);

    const dto = res.body.data.order;
    expect(dto.pricing.grandTotal).toBe(pv.body.data.pricing.grandTotal);
    expect(dto.pricing.offerDiscountTotal).toBe(150);
    expect(dto.offer).toMatchObject({ name: offer.name, freeUnits: 1, discountAmount: 150 });
    expect(dto.offer.freeItems[0]).toMatchObject({ productId: b._id.toString(), quantity: 1, unitPrice: 150, discount: 150 });
    expect(dto.offer.pairs[0]).toMatchObject({ freeProductId: b._id.toString(), freeUnitPrice: 150, count: 1 });
    const bLine = dto.items.find((i: { productId: string }) => i.productId === b._id.toString());
    expect(bLine).toMatchObject({ quantity: 1, freeQuantity: 1, offerDiscount: 150, lineTotal: 150 });

    const stored = await Order.findById(dto.id ?? dto.orderId).lean();
    expect(stored!.pricing.grandTotal).toBe(dto.pricing.grandTotal);
    expect(stored!.offer!.rules.eligibleProductIds).toHaveLength(2);

    expect(await OfferUsage.countDocuments({ offerId: offer._id })).toBe(1);
    expect((await Offer.findById(offer._id))!.usedCount).toBe(1);
    // Free units still ship, so stock drops for the full quantity.
    expect((await Product.findById(b._id))!.inventory.stockQuantity).toBe(19);
  });

  it("rejects (409) when the offer discount the customer was shown no longer matches", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);

    const res = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD", expectedOfferDiscount: 999 });
    expect(res.status).toBe(409);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(10);
  });

  it("a replayed Idempotency-Key doesn't redeem the offer twice", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    const offer = await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);
    const key = `idem-${RUN_ID}-${seq++}`;
    const body = { items: [line(p, 2)], addressId, paymentMethod: "COD" };
    const first = await checkout(user, body, key);
    const second = await checkout(user, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await OfferUsage.countDocuments({ offerId: offer._id })).toBe(1);
    expect((await Offer.findById(offer._id))!.usedCount).toBe(1);
  });

  it("cancelling the order releases the redemption and restores stock", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 10 });
    const offer = await makeOffer({ eligibleProductIds: [p._id] });
    const addressId = await makeAddress(user);
    const res = await checkout(user, { items: [line(p, 2)], addressId, paymentMethod: "COD" });
    expect(res.status).toBe(201);

    const cancel = await request(app)
      .post(`/api/orders/${res.body.data.order.orderNumber}/cancel`)
      .set("Cookie", cookie(user))
      .send({ reason: "changed mind" });
    expect(cancel.status).toBe(200);
    expect(await OfferUsage.countDocuments({ offerId: offer._id })).toBe(0);
    expect((await Offer.findById(offer._id))!.usedCount).toBe(0);
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(10);
  });

  it("enforces the per-user usage limit", async () => {
    const user = await makeUser();
    const p = await makeProduct({ price: 100, stock: 20 });
    await makeOffer({ eligibleProductIds: [p._id], usageLimitPerUser: 1 });
    const addressId = await makeAddress(user);
    const body = { items: [line(p, 2)], addressId, paymentMethod: "COD" };
    const first = await checkout(user, body);
    const second = await checkout(user, body);
    expect(first.status).toBe(201);
    expect(first.body.data.order.pricing.offerDiscountTotal).toBe(100);
    // Offer is exhausted for this user → order proceeds at full price, no free unit.
    expect(second.status).toBe(201);
    expect(second.body.data.order.pricing.offerDiscountTotal).toBe(0);
  });
});

describe("concurrency", () => {
  it("concurrent checkouts can't exceed the offer's total usage limit", async () => {
    const p = await makeProduct({ price: 100, stock: 100 });
    const offer = await makeOffer({ eligibleProductIds: [p._id], usageLimit: 2 });
    const users = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser(), makeUser()]);
    const addresses = await Promise.all(users.map(makeAddress));

    const results = await Promise.all(
      users.map((u, i) => checkout(u, { items: [line(p, 2)], addressId: addresses[i], paymentMethod: "COD" }))
    );
    const discounted = results.filter((r) => r.status === 201 && r.body.data.order.pricing.offerDiscountTotal === 100);
    expect(discounted.length).toBeLessThanOrEqual(2);
    expect((await Offer.findById(offer._id))!.usedCount).toBeLessThanOrEqual(2);
    expect(await OfferUsage.countDocuments({ offerId: offer._id })).toBe((await Offer.findById(offer._id))!.usedCount);

    // Every order that succeeded is internally consistent; every failure left nothing behind.
    const okCount = results.filter((r) => r.status === 201).length;
    expect(await Order.countDocuments({ userId: { $in: users.map((u) => u._id) } })).toBe(okCount);
    const sold = (
      await Order.find({ userId: { $in: users.map((u) => u._id) } }).lean()
    ).reduce((s, o) => s + o.items.reduce((n, i) => n + i.quantity, 0), 0);
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(100 - sold);
  });

  it("concurrent checkouts can't oversell inventory when the offer doubles the units", async () => {
    const p = await makeProduct({ price: 100, stock: 3 });
    await makeOffer({ eligibleProductIds: [p._id] });
    const users = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const addresses = await Promise.all(users.map(makeAddress));
    const results = await Promise.all(
      users.map((u, i) => checkout(u, { items: [line(p, 2)], addressId: addresses[i], paymentMethod: "COD" }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1); // 3 in stock, 2 per order
    expect((await Product.findById(p._id))!.inventory.stockQuantity).toBe(1);
  });
});
