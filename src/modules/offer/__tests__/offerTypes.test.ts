import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Offer, OfferUsage, OfferActivity, Order, ProductStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureOfferIndexes } from "../offer.indexes";
import {
  computeDiscountAllocation,
  computeRoleAutoAllocation,
  computeRoleSelectionAllocation,
  unitDiscountMinor,
  type OfferEngineRule,
  type RoleLine,
} from "../offerEngine";

// Offer types beyond the original pooled BOGO: Buy X Get Y Free with separate
// "buy" and "free" products, percentage and fixed-amount discounts, the admin
// rules that guard them, and how each reaches the cart, checkout and the order.

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const productIds: mongoose.Types.ObjectId[] = [];
const offerIds: mongoose.Types.ObjectId[] = [];
let seq = 0;
let userSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const u = await User.create({
    phone: `77${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  userIds.push(u._id);
  return u;
}
const cookie = (u: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(u)}`;

async function makeProduct(opts: { price?: number; stock?: number; status?: ProductStatus } = {}) {
  const n = seq++;
  const price = opts.price ?? 100;
  const p = await Product.create({
    name: `OfferTypes Product ${RUN_ID}-${n}`,
    slug: `offertypes-product-${RUN_ID}-${n}`,
    sku: `OTY-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: price + 100, sellingPrice: price },
    inventory: { stockQuantity: opts.stock ?? 50, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["offer"] },
    status: opts.status ?? "ACTIVE",
  });
  productIds.push(p._id);
  return p;
}
const id = (p: { _id: mongoose.Types.ObjectId }) => p._id.toString();
const line = (p: { _id: mongoose.Types.ObjectId }, quantity: number) => ({ productId: id(p), quantity });

let admin: InstanceType<typeof User>;
let customer: InstanceType<typeof User>;

const adminCreate = async (body: Record<string, unknown>) => {
  const res = await request(app).post("/api/admin/offers").set("Cookie", cookie(admin)).send(body);
  if (res.status === 201) offerIds.push(new mongoose.Types.ObjectId(res.body.data.offer.id));
  return res;
};
const adminPatch = (offerId: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/admin/offers/${offerId}`).set("Cookie", cookie(admin)).send(body);
const adminStatus = (offerId: string, status: string) =>
  request(app).post(`/api/admin/offers/${offerId}/status`).set("Cookie", cookie(admin)).send({ status });
const preview = (items: object[], extra: object = {}) =>
  request(app).post("/api/checkout/preview").set("Cookie", cookie(customer)).send({ items, ...extra });

let counter = 0;
const body = (over: Record<string, unknown>) => ({
  name: `Test Offer ${RUN_ID}-${counter++}`,
  type: "BOGO",
  eligibleProductIds: [],
  freeProductIds: [],
  buyQuantity: 1,
  maxFreeUnitsPerOrder: 5,
  ...over,
});

beforeAll(async () => {
  await connectDatabase();
  await ensureOfferIndexes();
  admin = await makeUser("admin");
  customer = await makeUser("user");
});

// Offers are global and automatic — disable everything this file created so
// one test's live offer can never bleed into the next.
afterEach(async () => {
  await Offer.updateMany({ _id: { $in: offerIds } }, { $set: { status: "DISABLED" } });
});

afterAll(async () => {
  await OfferUsage.deleteMany({ offerId: { $in: offerIds } });
  await OfferActivity.deleteMany({ offerId: { $in: offerIds } });
  await Offer.deleteMany({ _id: { $in: offerIds } });
  await Order.deleteMany({ userId: { $in: userIds } });
  await Product.deleteMany({ _id: { $in: productIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

// ---------------------------------------------------------------------------
// Engine (pure)
// ---------------------------------------------------------------------------

describe("engine — Buy X Get Y Free with separate buy/free products", () => {
  const rule: OfferEngineRule = { buyQuantity: 1, maxFreeUnitsPerOrder: 5, minPaidUnitPriceMinor: 0 };
  const buy = (productId: string, price: number, quantity: number): RoleLine => ({
    productId, unitPriceMinor: price * 100, quantity, canPay: true, canFree: false,
  });
  const free = (productId: string, price: number, quantity: number): RoleLine => ({
    productId, unitPriceMinor: price * 100, quantity, canPay: false, canFree: true,
  });
  const both = (productId: string, price: number, quantity: number): RoleLine => ({
    productId, unitPriceMinor: price * 100, quantity, canPay: true, canFree: true,
  });

  it("gives the free product even when it costs MORE than the bought one (the admin chose it)", () => {
    const r = computeRoleAutoAllocation([buy("nav", 140, 1), free("chk", 190, 1)], rule);
    expect(r.freeByProduct.get("chk")).toBe(1);
    expect(r.discountMinor).toBe(19000);
  });

  it("gives nothing — and says a free product is missing — when only buy products are in the cart", () => {
    const r = computeRoleAutoAllocation([buy("nav", 140, 4)], rule);
    expect(r.freeUnits).toBe(0);
    expect(r.needsFreeProduct).toBe(true);
  });

  it("gives nothing when the free product is in the cart but nothing qualifying was bought", () => {
    const r = computeRoleAutoAllocation([free("chk", 190, 2)], rule);
    expect(r.freeUnits).toBe(0);
    expect(r.unitsToNextFree).toBe(1);
  });

  it("buy 2 get 1 free needs two qualifying units per free unit", () => {
    const r2 = { ...rule, buyQuantity: 2 };
    expect(computeRoleAutoAllocation([buy("nav", 140, 1), free("chk", 190, 1)], r2).freeUnits).toBe(0);
    expect(computeRoleAutoAllocation([buy("nav", 140, 2), free("chk", 190, 1)], r2).freeUnits).toBe(1);
    expect(computeRoleAutoAllocation([buy("nav", 140, 4), free("chk", 190, 2)], r2).freeUnits).toBe(2);
  });

  it("respects the per-order cap", () => {
    const r = computeRoleAutoAllocation([buy("nav", 140, 10), free("chk", 190, 10)], { ...rule, maxFreeUnitsPerOrder: 2 });
    expect(r.freeUnits).toBe(2);
    expect(r.limitReached).toBe(true);
  });

  it("a product on both lists can serve either role but one unit never does both", () => {
    // 1 unit of a shared product can't be bought AND free.
    expect(computeRoleAutoAllocation([both("a", 100, 1)], rule).freeUnits).toBe(0);
    expect(computeRoleAutoAllocation([both("a", 100, 2)], rule).freeUnits).toBe(1);
  });

  it("customer selection: a product outside the free list is rejected and stays paid", () => {
    const r = computeRoleSelectionAllocation(
      [buy("nav", 140, 2), free("chk", 190, 1)],
      [{ productId: "nav", quantity: 1 }],
      rule
    );
    expect(r.freeUnits).toBe(0);
    expect(r.rejected[0]).toMatchObject({ productId: "nav", reason: "NOT_ELIGIBLE" });
  });

  it("customer selection: a valid free pick is honoured", () => {
    const r = computeRoleSelectionAllocation(
      [buy("nav", 140, 1), free("chk", 190, 1)],
      [{ productId: "chk", quantity: 1 }],
      rule
    );
    expect(r.freeByProduct.get("chk")).toBe(1);
    expect(r.rejected).toHaveLength(0);
  });

  it("customer selection: a free pick without a qualifying purchase is rejected", () => {
    const r = computeRoleSelectionAllocation([free("chk", 190, 1)], [{ productId: "chk", quantity: 1 }], rule);
    expect(r.freeUnits).toBe(0);
    expect(r.rejected[0].reason).toBe("NOT_ENOUGH_PAID_ITEMS");
  });

  it("the minimum purchased price applies to the qualifying units", () => {
    const r = computeRoleAutoAllocation([buy("nav", 100, 1), free("chk", 190, 1)], { ...rule, minPaidUnitPriceMinor: 15000 });
    expect(r.freeUnits).toBe(0);
  });
});

describe("engine — percentage and fixed-amount discounts", () => {
  it("percentage: per-unit paise times quantity, only on the lines handed in", () => {
    const r = computeDiscountAllocation(
      [{ productId: "a", unitPriceMinor: 19900, quantity: 3 }],
      { kind: "PERCENTAGE", percent: 50 }
    );
    expect(unitDiscountMinor(19900, { kind: "PERCENTAGE", percent: 50 })).toBe(9950);
    expect(r.discountMinor).toBe(9950 * 3);
    expect(r.discountMinorByProduct.get("a")).toBe(29850);
  });

  it("fixed: a flat amount per unit, never more than the unit costs", () => {
    const r = computeDiscountAllocation(
      [
        { productId: "a", unitPriceMinor: 30000, quantity: 2 },
        { productId: "cheap", unitPriceMinor: 6000, quantity: 1 },
      ],
      { kind: "FIXED", amountMinor: 10000 }
    );
    expect(r.discountMinorByProduct.get("a")).toBe(20000);
    expect(r.discountMinorByProduct.get("cheap")).toBe(6000); // capped at the unit price
  });

  it("100% off makes the unit free but cannot go below zero", () => {
    expect(unitDiscountMinor(12345, { kind: "PERCENTAGE", percent: 100 })).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Admin: creating, validating, activating
// ---------------------------------------------------------------------------

describe("admin — Buy X Get Y Free configuration", () => {
  it("1. creates a BOGO offer where the free product is the same as the qualifying product", async () => {
    const p = await makeProduct({ price: 150 });
    const res = await adminCreate(body({ name: "Buy 1 Get 1 Free", eligibleProductIds: [id(p)], freeProductIds: [id(p)] }));
    expect(res.status).toBe(201);
    expect(res.body.data.offer).toMatchObject({ name: "Buy 1 Get 1 Free", type: "BOGO" });
    expect(res.body.data.offer.eligibleProducts.map((x: { id: string }) => x.id)).toEqual([id(p)]);
    expect(res.body.data.offer.freeProducts.map((x: { id: string }) => x.id)).toEqual([id(p)]);
  });

  it("2. creates a BOGO offer with a different free product and keeps them separate", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const res = await adminCreate(body({ eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    expect(res.status).toBe(201);
    expect(res.body.data.offer.eligibleProducts.map((x: { id: string }) => x.id)).toEqual([id(nav)]);
    expect(res.body.data.offer.freeProducts.map((x: { id: string }) => x.id)).toEqual([id(chk)]);
    expect(res.body.data.offer.freeProductCount).toBe(1);
  });

  it("3. refuses to activate a BOGO offer that has no free product — on create and on the status endpoint", async () => {
    const p = await makeProduct();
    // Created live without a free product → rejected outright.
    for (const status of ["ACTIVE", "SCHEDULED"]) {
      const res = await adminCreate(
        body({ eligibleProductIds: [id(p)], status, startsAt: new Date(Date.now() + 86_400_000).toISOString() })
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/free product/i);
    }
    // A draft may be saved incomplete, but cannot then be activated.
    const draft = await adminCreate(body({ eligibleProductIds: [id(p)] }));
    expect(draft.status).toBe(201);
    expect(draft.body.data.offer.freeProducts).toEqual([]);
    const on = await adminStatus(draft.body.data.offer.id, "ACTIVE");
    expect(on.status).toBe(409);
    expect(on.body.message).toMatch(/free product/i);
    // …until the free product is chosen.
    expect((await adminPatch(draft.body.data.offer.id, { freeProductIds: [id(p)] })).status).toBe(200);
    expect((await adminStatus(draft.body.data.offer.id, "ACTIVE")).status).toBe(200);
  });

  it("refuses to activate any offer without qualifying products", async () => {
    const p = await makeProduct();
    const res = await adminCreate(body({ eligibleProductIds: [], freeProductIds: [id(p)] }));
    expect(res.status).toBe(400);
  });

  it("rejects a free product that does not exist, or that is also excluded", async () => {
    const p = await makeProduct();
    const ghost = new mongoose.Types.ObjectId().toString();
    expect((await adminCreate(body({ eligibleProductIds: [id(p)], freeProductIds: [ghost] }))).status).toBe(400);
    const other = await makeProduct();
    expect(
      (await adminCreate(body({ eligibleProductIds: [id(p)], freeProductIds: [id(other)], excludedProductIds: [id(other)] }))).status
    ).toBe(400);
  });

  it("rejects free products on a percentage offer, and malformed configuration", async () => {
    const p = await makeProduct();
    expect(
      (await adminCreate(body({ type: "PERCENTAGE", discountPercent: 10, eligibleProductIds: [id(p)], freeProductIds: [id(p)] }))).status
    ).toBe(400);
    expect((await adminCreate(body({ type: "PERCENTAGE", eligibleProductIds: [id(p)] }))).status).toBe(400); // no percent
    expect((await adminCreate(body({ type: "PERCENTAGE", discountPercent: 0, eligibleProductIds: [id(p)] }))).status).toBe(400);
    expect((await adminCreate(body({ type: "PERCENTAGE", discountPercent: 101, eligibleProductIds: [id(p)] }))).status).toBe(400);
    expect((await adminCreate(body({ type: "FIXED", eligibleProductIds: [id(p)] }))).status).toBe(400); // no amount
    expect((await adminCreate(body({ type: "FIXED", discountAmount: -5, eligibleProductIds: [id(p)] }))).status).toBe(400);
    expect((await adminCreate(body({ type: "BOGO", discountPercent: 10, eligibleProductIds: [id(p)], freeProductIds: [id(p)] }))).status).toBe(400);
    expect((await adminCreate(body({ type: "PERCENTAGE", discountPercent: 10, discountAmount: 5, eligibleProductIds: [id(p)] }))).status).toBe(400);
    expect((await adminCreate(body({ type: "NOPE", eligibleProductIds: [id(p)] }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Cart / checkout behaviour per type
// ---------------------------------------------------------------------------

describe("cart & checkout — Buy X Get Y Free with separate products", () => {
  it("frees the configured free product and the totals add up", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ name: "Buy Navadhanya, Get Chicken Free", eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    expect((await adminStatus(created.body.data.offer.id, "ACTIVE")).status).toBe(200);

    const res = await preview([line(nav, 1), line(chk, 1)]);
    expect(res.status).toBe(200);
    expect(res.body.data.offer).toMatchObject({
      name: "Buy Navadhanya, Get Chicken Free",
      type: "BOGO",
      applied: true,
      discountAmount: 190,
      freeUnits: 1,
    });
    expect(res.body.data.offer.freeCandidateProductIds).toEqual([id(chk)]);
    expect(res.body.data.pricing).toMatchObject({ subtotal: 330, offerDiscountTotal: 190 });
    const items = res.body.data.items as { productId: string; freeQuantity: number; offerDiscount: number }[];
    expect(items.find((i) => i.productId === id(chk))).toMatchObject({ freeQuantity: 1, offerDiscount: 190 });
    expect(items.find((i) => i.productId === id(nav))).toMatchObject({ freeQuantity: 0, offerDiscount: 0 });
  });

  it("does not apply — and says what is missing — when the free product isn't in the cart", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const res = await preview([line(nav, 3)]);
    expect(res.body.data.offer.applied).toBe(false);
    expect(res.body.data.offer.needsFreeProduct).toBe(true);
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("does not apply when only the free product is bought (nothing qualifying)", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const res = await preview([line(chk, 2)]);
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("a manipulated free selection can't make a non-free product free", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const res = await preview([line(nav, 2), line(chk, 1)], { freeSelections: [{ productId: id(nav), quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.offer.applied).toBe(false);
    expect(res.body.data.pricing.offerDiscountTotal).toBe(0);
    expect(res.body.data.offer.rejected[0]).toMatchObject({ productId: id(nav), reason: "NOT_ELIGIBLE" });
  });

  it("buy 2 get 1 free needs two qualifying units", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ name: "Buy 2 Get 1 Free", buyQuantity: 2, eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    expect((await preview([line(nav, 1), line(chk, 1)])).body.data.pricing.offerDiscountTotal).toBe(0);
    expect((await preview([line(nav, 2), line(chk, 1)])).body.data.pricing.offerDiscountTotal).toBe(190);
  });
});

describe("cart & checkout — percentage discount", () => {
  it("4/5. applies only to the selected products and not to anything else", async () => {
    const chosen = await makeProduct({ price: 200 });
    const other = await makeProduct({ price: 200 });
    const created = await adminCreate(body({ name: "50% Off", type: "PERCENTAGE", discountPercent: 50, eligibleProductIds: [id(chosen)] }));
    expect(created.status).toBe(201);
    expect(created.body.data.offer).toMatchObject({ type: "PERCENTAGE", discountPercent: 50, freeProductCount: 0 });
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const res = await preview([line(chosen, 2), line(other, 1)]);
    expect(res.body.data.offer).toMatchObject({ name: "50% Off", type: "PERCENTAGE", applied: true, discountAmount: 200, freeUnits: 0 });
    expect(res.body.data.pricing).toMatchObject({ subtotal: 600, offerDiscountTotal: 200 });
    const items = res.body.data.items as { productId: string; offerDiscount: number; freeQuantity: number }[];
    expect(items.find((i) => i.productId === id(chosen))).toMatchObject({ offerDiscount: 200, freeQuantity: 0 });
    expect(items.find((i) => i.productId === id(other))).toMatchObject({ offerDiscount: 0 });

    // A cart with only unselected products gets nothing and no offer at all.
    const none = await preview([line(other, 3)]);
    expect(none.body.data.offer).toBeNull();
    expect(none.body.data.pricing.offerDiscountTotal).toBe(0);
  });

  it("with no products selected nothing is discounted (never 'all products')", async () => {
    const p = await makeProduct({ price: 200 });
    const noneSelected = await adminCreate(body({ type: "PERCENTAGE", discountPercent: 50, eligibleProductIds: [] }));
    expect(noneSelected.status).toBe(400);
    // …and a direct write with an empty list is refused by the model too.
    await expect(
      Offer.create({ name: "x", type: "PERCENTAGE", discountPercent: 50, status: "ACTIVE", eligibleProductIds: [] })
    ).rejects.toThrow();
    expect((await preview([line(p, 1)])).body.data.offer).toBeNull();
  });
});

describe("cart & checkout — fixed amount discount", () => {
  it("takes the amount off every unit of the selected products, capped at the unit price", async () => {
    const dear = await makeProduct({ price: 300 });
    const cheap = await makeProduct({ price: 60 });
    const created = await adminCreate(body({ name: "Flat ₹100 Off", type: "FIXED", discountAmount: 100, eligibleProductIds: [id(dear), id(cheap)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const res = await preview([line(dear, 2), line(cheap, 1)]);
    expect(res.body.data.offer).toMatchObject({ name: "Flat ₹100 Off", type: "FIXED", discountAmountPerUnit: 100, applied: true });
    expect(res.body.data.offer.discountAmount).toBe(260); // 2×100 + min(100, 60)
    expect(res.body.data.pricing).toMatchObject({ subtotal: 660, offerDiscountTotal: 260 });
  });
});

describe("orders — what is recorded", () => {
  async function placeOrder(items: object[]) {
    const address = await request(app).post("/api/addresses").set("Cookie", cookie(customer)).send({
      label: "Home", receiverName: "Asha Menon", receiverPhone: "9876543210", houseNo: "12",
      area: "Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020",
    });
    return request(app)
      .post("/api/checkout")
      .set("Cookie", cookie(customer))
      .set("Idempotency-Key", `ot-${RUN_ID}-${Math.random().toString(36).slice(2)}`)
      .send({ items, addressId: address.body.data.address.addressId, paymentMethod: "COD" });
  }

  it("9. a percentage offer is frozen on the order, and line discounts sum to the order discount", async () => {
    const chosen = await makeProduct({ price: 200 });
    const other = await makeProduct({ price: 100 });
    const created = await adminCreate(body({ name: "25% Off Chosen", type: "PERCENTAGE", discountPercent: 25, eligibleProductIds: [id(chosen)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const shown = await preview([line(chosen, 2), line(other, 1)]);
    const res = await placeOrder([line(chosen, 2), line(other, 1)]);
    expect(res.status).toBe(201);
    const order = await Order.findOne({ userId: customer._id }).sort({ createdAt: -1 }).lean();
    expect(order).toBeTruthy();

    // What the customer was shown is what was charged.
    expect(order!.pricing.offerDiscountTotal).toBe(shown.body.data.pricing.offerDiscountTotal);
    expect(order!.pricing.offerDiscountTotal).toBe(100); // 25% of 2×200
    const lineSum = order!.items.reduce((sum, i) => sum + (i.offerDiscount ?? 0), 0);
    expect(lineSum).toBeCloseTo(100, 2);
    expect(order!.items.find((i) => i.productId.toString() === id(other))?.offerDiscount ?? 0).toBe(0);
    expect(order!.pricing.grandTotal).toBeCloseTo(
      order!.pricing.subtotal - order!.pricing.offerDiscountTotal + order!.pricing.shippingFee + (order!.pricing.taxTotal ?? 0),
      2
    );

    // The frozen snapshot survives later edits to the live offer.
    expect(order!.offer).toMatchObject({ name: "25% Off Chosen", type: "PERCENTAGE", discountPercent: 25, freeUnits: 0, discountAmount: 100 });
    expect(order!.offer!.discountedItems).toHaveLength(1);
    expect(order!.offer!.discountedItems![0]).toMatchObject({ quantity: 2, unitPrice: 200, discount: 100 });
    expect(order!.offer!.freeItems).toHaveLength(0);
    await adminPatch(created.body.data.offer.id, { name: "Renamed later", discountPercent: 90 });
    const again = await Order.findById(order!._id).lean();
    expect(again!.offer).toMatchObject({ name: "25% Off Chosen", discountPercent: 25 });
  });

  it("9. a BOGO order with a different free product records the free item and the rule", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ name: "Buy Nav Get Chicken", eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");

    const res = await placeOrder([line(nav, 1), line(chk, 1)]);
    expect(res.status).toBe(201);
    const order = await Order.findOne({ userId: customer._id }).sort({ createdAt: -1 }).lean();
    expect(order!.pricing.offerDiscountTotal).toBe(190);
    expect(order!.offer).toMatchObject({ type: "BOGO", freeUnits: 1, discountAmount: 190 });
    expect(order!.offer!.freeItems[0]).toMatchObject({ quantity: 1, unitPrice: 190 });
    expect(order!.offer!.rules.freeProductIds?.map(String)).toEqual([id(chk)]);
    const chkLine = order!.items.find((i) => i.productId.toString() === id(chk));
    expect(chkLine).toMatchObject({ freeQuantity: 1, offerDiscount: 190 });
    expect(await OfferUsage.countDocuments({ offerId: created.body.data.offer.id })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Editing, deactivating, deleting, overlapping offers, old offers
// ---------------------------------------------------------------------------

describe("admin — editing and lifecycle", () => {
  it("7. editing updates the same offer and keeps product associations untouched", async () => {
    const a = await makeProduct();
    const b = await makeProduct();
    const c = await makeProduct();
    const created = await adminCreate(body({ name: "Original", eligibleProductIds: [id(a), id(b)], freeProductIds: [id(c)] }));
    const offerId = created.body.data.offer.id;
    const before = await Offer.countDocuments({});

    const renamed = await adminPatch(offerId, { name: "Renamed", maxFreeUnitsPerOrder: 3 });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.offer.name).toBe("Renamed");
    expect(renamed.body.data.offer.eligibleProducts.map((x: { id: string }) => x.id).sort()).toEqual([id(a), id(b)].sort());
    expect(renamed.body.data.offer.freeProducts.map((x: { id: string }) => x.id)).toEqual([id(c)]);
    expect(await Offer.countDocuments({})).toBe(before); // no duplicate created

    const swapped = await adminPatch(offerId, { freeProductIds: [id(a)] });
    expect(swapped.body.data.offer.freeProducts.map((x: { id: string }) => x.id)).toEqual([id(a)]);
    expect(swapped.body.data.offer.eligibleProducts).toHaveLength(2);
    expect(swapped.body.data.offer.activity.some((e: { changes: { field: string }[] }) => e.changes.some((ch) => ch.field === "Free products" || ch.field === "Title"))).toBe(true);
  });

  it("changing the type drops the old type's settings instead of leaving them behind", async () => {
    const a = await makeProduct();
    const created = await adminCreate(body({ eligibleProductIds: [id(a)], freeProductIds: [id(a)] }));
    const offerId = created.body.data.offer.id;

    const toPct = await adminPatch(offerId, { type: "PERCENTAGE", discountPercent: 20 });
    expect(toPct.status).toBe(200);
    expect(toPct.body.data.offer).toMatchObject({ type: "PERCENTAGE", discountPercent: 20, freeProductCount: 0 });
    expect((await Offer.findById(offerId).lean())!.freeProductIds).toHaveLength(0);

    const toFixed = await adminPatch(offerId, { type: "FIXED", discountAmount: 50 });
    expect(toFixed.body.data.offer).toMatchObject({ type: "FIXED", discountAmount: 50, discountPercent: null });

    // Back to BOGO: it needs a free product before it can go live again.
    const back = await adminPatch(offerId, { type: "BOGO" });
    expect(back.status).toBe(200);
    expect((await adminStatus(offerId, "ACTIVE")).status).toBe(409);
  });

  it("a percentage offer can't be switched on without a percentage, nor a fixed one without an amount", async () => {
    const a = await makeProduct();
    const created = await adminCreate(body({ eligibleProductIds: [id(a)], freeProductIds: [id(a)] }));
    const offerId = created.body.data.offer.id;
    expect((await adminPatch(offerId, { type: "PERCENTAGE" })).status).toBe(400);
    expect((await adminPatch(offerId, { type: "FIXED" })).status).toBe(400);
  });

  it("8. deactivating stops the offer applying and hides it from the storefront", async () => {
    const p = await makeProduct({ price: 200 });
    const created = await adminCreate(body({ type: "PERCENTAGE", discountPercent: 50, eligibleProductIds: [id(p)] }));
    const offerId = created.body.data.offer.id;
    await adminStatus(offerId, "ACTIVE");
    expect((await preview([line(p, 1)])).body.data.pricing.offerDiscountTotal).toBe(100);
    const pub = await request(app).get("/api/offers/active");
    const live = pub.body.data.offers.find((o: { id: string }) => o.id === offerId);
    expect(live).toMatchObject({ name: created.body.data.offer.name, mode: "PERCENTAGE", discountPercent: 50, eligibleProductIds: [id(p)] });

    await adminStatus(offerId, "DISABLED");
    expect((await preview([line(p, 1)])).body.data.pricing.offerDiscountTotal).toBe(0);
    const gone = await request(app).get("/api/offers/active");
    expect(gone.body.data.offers.some((o: { id: string }) => o.id === offerId)).toBe(false);
  });

  it("the public offers payload names the products an offer is about", async () => {
    const nav = await makeProduct({ price: 140 });
    const chk = await makeProduct({ price: 190 });
    const created = await adminCreate(body({ eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] }));
    await adminStatus(created.body.data.offer.id, "ACTIVE");
    const pub = await request(app).get("/api/offers/active");
    const o = pub.body.data.offers.find((x: { id: string }) => x.id === created.body.data.offer.id);
    expect(o).toMatchObject({ mode: "BOGO_ROLES", eligibleProductIds: [id(nav)], freeProductIds: [id(chk)] });
    expect(Object.keys(o.productNames).sort()).toEqual([id(nav), id(chk)].sort());
    expect(o.productNames[id(chk)].name).toMatch(/OfferTypes Product/);
  });

  it("deleting: only a deactivated/draft offer that no order used", async () => {
    const p = await makeProduct();
    const draft = await adminCreate(body({ eligibleProductIds: [id(p)], freeProductIds: [id(p)] }));
    const draftId = draft.body.data.offer.id;
    expect((await request(app).delete(`/api/admin/offers/${draftId}`).set("Cookie", cookie(customer))).status).toBe(403);
    expect((await request(app).delete(`/api/admin/offers/${draftId}`).set("Cookie", cookie(admin))).status).toBe(200);
    expect(await Offer.findById(draftId)).toBeNull();
    expect((await request(app).delete(`/api/admin/offers/${draftId}`).set("Cookie", cookie(admin))).status).toBe(404);

    const live = await adminCreate(body({ eligibleProductIds: [id(p)], freeProductIds: [id(p)] }));
    await adminStatus(live.body.data.offer.id, "ACTIVE");
    const refused = await request(app).delete(`/api/admin/offers/${live.body.data.offer.id}`).set("Cookie", cookie(admin));
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/deactivate/i);

    // Once an order redeemed it, it's history.
    await adminStatus(live.body.data.offer.id, "DISABLED");
    await Offer.updateOne({ _id: live.body.data.offer.id }, { $set: { usedCount: 1 } });
    const used = await request(app).delete(`/api/admin/offers/${live.body.data.offer.id}`).set("Cookie", cookie(admin));
    expect(used.status).toBe(409);
    expect(used.body.message).toMatch(/used on orders/i);
  });
});

describe("several offers on one product / old offers", () => {
  it("10. never combines offers: the one that saves the customer most applies, once", async () => {
    const p = await makeProduct({ price: 200 });
    const small = await adminCreate(body({ name: "10% Off", type: "PERCENTAGE", discountPercent: 10, eligibleProductIds: [id(p)] }));
    const big = await adminCreate(body({ name: "Flat 60 Off", type: "FIXED", discountAmount: 60, eligibleProductIds: [id(p)] }));
    await adminStatus(small.body.data.offer.id, "ACTIVE");
    await adminStatus(big.body.data.offer.id, "ACTIVE");

    const res = await preview([line(p, 1)]);
    expect(res.body.data.offer.name).toBe("Flat 60 Off");
    expect(res.body.data.offer.discountAmount).toBe(60); // not 20 + 60
    expect(res.body.data.pricing.offerDiscountTotal).toBe(60);

    // A bigger percentage takes over; ties keep the oldest offer.
    await adminPatch(small.body.data.offer.id, { discountPercent: 50 });
    expect((await preview([line(p, 1)])).body.data.offer.name).toBe("10% Off");
    expect((await preview([line(p, 1)])).body.data.pricing.offerDiscountTotal).toBe(100);
  });

  it("11. an offer saved before free products existed still works exactly as before", async () => {
    const a = await makeProduct({ price: 180 });
    const b = await makeProduct({ price: 150 });
    const legacy = await Offer.create({
      name: `Legacy BOGO ${RUN_ID}`,
      type: "BOGO",
      status: "ACTIVE",
      buyQuantity: 1,
      maxFreeUnitsPerOrder: 2,
      eligibleProductIds: [a._id, b._id],
    });
    offerIds.push(legacy._id);
    expect(legacy.freeProductIds).toHaveLength(0);

    // Pooled: the cheaper unit is free; a dearer one can't be picked free.
    const auto = await preview([line(a, 1), line(b, 1)]);
    expect(auto.body.data.offer).toMatchObject({ applied: true, discountAmount: 150 });
    const pick = await preview([line(a, 1), line(b, 1)], { freeSelections: [{ productId: id(a), quantity: 1 }] });
    expect(pick.body.data.pricing.offerDiscountTotal).toBe(0);
    expect(pick.body.data.offer.rejected[0].reason).toBe("PRICE_TOO_HIGH");

    // It can be switched off and on again only once it names a free product.
    expect((await adminStatus(legacy._id.toString(), "DISABLED")).status).toBe(200);
    expect((await adminStatus(legacy._id.toString(), "ACTIVE")).status).toBe(409);
    expect((await adminPatch(legacy._id.toString(), { freeProductIds: [id(a), id(b)] })).status).toBe(200);
    expect((await adminStatus(legacy._id.toString(), "ACTIVE")).status).toBe(200);
    // Same list for buying and for free ⇒ still the pooled behaviour.
    expect((await preview([line(a, 1), line(b, 1)])).body.data.pricing.offerDiscountTotal).toBe(150);
  });
});
