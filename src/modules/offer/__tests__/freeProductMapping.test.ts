import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Offer, OfferUsage, OfferActivity, Order, ProductStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureOfferIndexes } from "../offer.indexes";
import { computeMappedAutoAllocation, computeMappedSelectionAllocation, type MappedLine } from "../offerEngine";

// Buy 1 Get 1 Free with per-product free-product rules and the price rule
// "a free item never costs more than the item bought".

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const productIds: mongoose.Types.ObjectId[] = [];
const offerIds: mongoose.Types.ObjectId[] = [];
let seq = 0;
let userSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const u = await User.create({ phone: `79${RUN_ID}${String(userSeq++).padStart(3, "0")}`, countryCode: "+91", phoneVerified: true, role });
  userIds.push(u._id);
  return u;
}
const cookie = (u: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(u)}`;

async function makeProduct(name: string, price: number, opts: { stock?: number; status?: ProductStatus } = {}) {
  const n = seq++;
  const p = await Product.create({
    name: `${name} ${RUN_ID}`,
    slug: `map-${name.toLowerCase().replace(/\W+/g, "-")}-${RUN_ID}-${n}`,
    sku: `MAP-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: price + 50, sellingPrice: price },
    inventory: { stockQuantity: opts.stock ?? 50, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["offer"] },
    status: opts.status ?? "ACTIVE",
  });
  productIds.push(p._id);
  return p;
}
const id = (p: { _id: mongoose.Types.ObjectId }) => p._id.toString();
const line = (p: { _id: mongoose.Types.ObjectId }, quantity: number) => ({ productId: id(p), quantity });
const pick = line;

let admin: InstanceType<typeof User>;
let customer: InstanceType<typeof User>;
let nav: Awaited<ReturnType<typeof makeProduct>>;
let broc: typeof nav;
let mixed: typeof nav;
let chicken: typeof nav;
let counter = 0;

const offerBody = (over: Record<string, unknown> = {}) => ({
  name: `Buy 1 Get 1 ${RUN_ID}-${counter++}`,
  type: "BOGO",
  buyQuantity: 1,
  maxFreeUnitsPerOrder: 5,
  eligibleProductIds: [id(nav), id(broc), id(mixed), id(chicken)],
  // Fallback for any product without its own rule (Chicken Oats: everything configured).
  freeProductIds: [id(nav), id(broc), id(mixed), id(chicken)],
  freeProductRules: [
    { buyProductId: id(nav), freeProductIds: [id(mixed)] },
    { buyProductId: id(broc), freeProductIds: [id(nav), id(mixed)] },
    { buyProductId: id(mixed), freeProductIds: [id(chicken)] }, // dearer than Mixed: the price rule must win
  ],
  ...over,
});

async function liveOffer(over: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/admin/offers").set("Cookie", cookie(admin)).send(offerBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const offerId = res.body.data.offer.id;
  offerIds.push(new mongoose.Types.ObjectId(offerId));
  expect((await request(app).post(`/api/admin/offers/${offerId}/status`).set("Cookie", cookie(admin)).send({ status: "ACTIVE" })).status).toBe(200);
  return offerId as string;
}
const evaluate = (items: object[], freeSelections?: object[]) =>
  request(app).post("/api/offers/evaluate").send({ items, ...(freeSelections ? { freeSelections } : {}) });
const preview = (items: object[], extra: object = {}) =>
  request(app).post("/api/checkout/preview").set("Cookie", cookie(customer)).send({ items, ...extra });
const optionIds = (res: request.Response) => (res.body.data.offer?.freeOptions ?? []).map((o: { productId: string }) => o.productId);

beforeAll(async () => {
  await connectDatabase();
  await ensureOfferIndexes();
  admin = await makeUser("admin");
  customer = await makeUser("user");
  nav = await makeProduct("Navadhanya Porridge", 190);
  broc = await makeProduct("Broccoli Mushroom Oats Porridge", 220);
  mixed = await makeProduct("Mixed Millet Porridge", 190);
  chicken = await makeProduct("Chicken Oats Porridge", 230);
});

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

describe("engine — mapped pairing", () => {
  const rule = { buyQuantity: 1, maxFreeUnitsPerOrder: 5, minPaidUnitPriceMinor: 0 };
  const L = (productId: string, price: number, quantity: number, allowed: string[]): MappedLine => ({
    productId, unitPriceMinor: price * 100, quantity, canPay: true, canFree: true, allowedFree: new Set(allowed),
  });

  it("never frees a dearer item, even when the mapping names it", () => {
    const r = computeMappedAutoAllocation([L("mixed", 190, 1, ["chicken"]), L("chicken", 230, 1, ["chicken"])], rule);
    expect(r.freeUnits).toBe(0);
  });

  it("finds the pairing that saves the most (augmenting match, not first-fit)", () => {
    // broc can pay for nav or mixed; nav can pay only for mixed. Both frees need broc if nav is free first.
    const lines = [L("broc", 220, 1, ["nav", "mixed"]), L("nav", 190, 1, ["mixed"]), L("mixed", 190, 1, ["chicken"])];
    const r = computeMappedAutoAllocation(lines, rule);
    expect(r.freeUnits).toBe(1);
    expect(r.discountMinor).toBe(19000);
  });

  it("selection: an unmapped pick stays paid with a reason", () => {
    const r = computeMappedSelectionAllocation(
      [L("nav", 190, 1, ["mixed"]), L("mixed", 190, 1, ["chicken"])],
      [{ productId: "nav", quantity: 1 }],
      rule
    );
    expect(r.freeUnits).toBe(0);
    expect(r.rejected[0]).toMatchObject({ productId: "nav", reason: "PRICE_TOO_HIGH" });
  });
});

describe("suggestions appear as soon as ONE qualifying product is in the cart", () => {
  it("Navadhanya (₹190) → Mixed Millet only", async () => {
    await liveOffer();
    const res = await evaluate([line(nav, 1)]);
    expect(optionIds(res)).toEqual([id(mixed)]);
    expect(res.body.data.offer.freeOptions[0]).toMatchObject({ unitPrice: 190, claimableUnits: 1, unitsToUnlock: 0, rank: 1 });
    expect(res.body.data.offer.freeUnits).toBe(0); // nothing is added silently
  });

  it("Broccoli & Mushroom (₹220) → Navadhanya and Mixed Millet", async () => {
    await liveOffer();
    expect(new Set(optionIds(await evaluate([line(broc, 1)])))).toEqual(new Set([id(nav), id(mixed)]));
  });

  it("Mixed Millet (₹190) → Chicken Oats is mapped but dearer, so nothing is offered", async () => {
    await liveOffer();
    const res = await evaluate([line(mixed, 1)]);
    expect(optionIds(res)).toEqual([]);
  });

  it("Chicken Oats (₹230) → every configured product, best saving first", async () => {
    await liveOffer();
    const res = await evaluate([line(chicken, 1)]);
    const ids = optionIds(res);
    expect(ids[0]).toBe(id(chicken)); // ₹230 saves the most
    expect(ids[1]).toBe(id(broc));
    expect(new Set(ids)).toEqual(new Set([id(chicken), id(broc), id(nav), id(mixed)]));
  });

  it("excludes out-of-stock and inactive products", async () => {
    const out = await makeProduct("Sold Out Porridge", 150, { stock: 0 });
    const draft = await makeProduct("Draft Porridge", 150, { status: "DRAFT" });
    await liveOffer({
      eligibleProductIds: [id(chicken), id(out), id(draft)],
      freeProductIds: [id(out), id(draft), id(nav)],
      freeProductRules: [{ buyProductId: id(chicken), freeProductIds: [id(out), id(draft), id(nav)] }],
    });
    const ids = optionIds(await evaluate([line(chicken, 1)]));
    expect(ids).toEqual([id(nav)]);
  });
});

describe("a plain Buy 1 Get 1 offer (no mapping configured) suggests within the price rule", () => {
  it("shows eligible products priced at or below the one bought", async () => {
    const created = await Offer.create({
      name: `Legacy BOGO ${RUN_ID}`, type: "BOGO", buyQuantity: 1, maxFreeUnitsPerOrder: 5,
      eligibleProductIds: [nav._id, broc._id, mixed._id, chicken._id], status: "ACTIVE",
    });
    offerIds.push(created._id);
    expect(new Set(optionIds(await evaluate([line(nav, 1)])))).toEqual(new Set([id(nav), id(mixed)]));
    expect(optionIds(await evaluate([line(chicken, 1)]))).toHaveLength(4);
  });
});

describe("selection, price rule and totals on the server", () => {
  it("applies the picked free product and recalculates when the pick, product or quantity changes", async () => {
    await liveOffer();
    const one = (await preview([line(nav, 1), line(mixed, 1)], { freeSelections: [pick(mixed, 1)] })).body.data;
    expect(one.offer).toMatchObject({ applied: true, freeUnits: 1, discountAmount: 190, freeByProduct: { [id(mixed)]: 1 } });
    expect(one.pricing).toMatchObject({ subtotal: 380, offerDiscountTotal: 190 });

    // Different pick: Navadhanya as free needs a payer that allows it (only Broccoli does).
    const wrong = (await preview([line(nav, 1), line(mixed, 1)], { freeSelections: [pick(nav, 1)] })).body.data.offer;
    expect(wrong.freeUnits).toBe(0);
    expect(wrong.rejected[0].reason).toBe("PRICE_TOO_HIGH");

    const withBroc = (await preview([line(broc, 1), line(nav, 1)], { freeSelections: [pick(nav, 1)] })).body.data;
    expect(withBroc.offer).toMatchObject({ freeUnits: 1, discountAmount: 190 });
    expect(withBroc.pricing).toMatchObject({ subtotal: 410, offerDiscountTotal: 190 });

    // Quantity: two of each, two free; cap of 1 limits it.
    const two = (await preview([line(nav, 2), line(mixed, 2)], { freeSelections: [pick(mixed, 2)] })).body.data.offer;
    expect(two).toMatchObject({ freeUnits: 2, discountAmount: 380 });
  });

  it("a dearer free item is rejected no matter what the client sends", async () => {
    await liveOffer();
    const res = await preview(
      [{ ...line(mixed, 1), unitPrice: 999 }, line(chicken, 1)],
      { freeSelections: [{ ...pick(chicken, 1), price: 0, discount: 500 }], discountAmount: 500 }
    );
    expect(res.status).toBe(200);
    expect(res.body.data.offer.freeUnits).toBe(0);
    expect(res.body.data.pricing.offerDiscountTotal ?? 0).toBe(0);
    expect(res.body.data.pricing.subtotal).toBe(420);
  });

  it("respects the per-order cap and never frees more units than there are paid partners", async () => {
    await liveOffer({ maxFreeUnitsPerOrder: 1 });
    const capped = (await preview([line(nav, 2), line(mixed, 2)], { freeSelections: [pick(mixed, 2)] })).body.data.offer;
    expect(capped.freeUnits).toBe(1);
    expect(capped.rejected.some((r: { reason: string }) => r.reason === "LIMIT_REACHED")).toBe(true);
    await Offer.updateMany({ _id: { $in: offerIds } }, { $set: { status: "DISABLED" } });
    await liveOffer();
    const partners = (await preview([line(nav, 1), line(mixed, 3)], { freeSelections: [pick(mixed, 3)] })).body.data.offer;
    expect(partners.freeUnits).toBe(1); // only one Navadhanya to pay for them
  });

  it("an out-of-stock free product earns nothing", async () => {
    const out = await makeProduct("Out Porridge", 100, { stock: 0 });
    await liveOffer({ eligibleProductIds: [id(nav), id(out)], freeProductIds: [id(out)], freeProductRules: [{ buyProductId: id(nav), freeProductIds: [id(out)] }] });
    const res = await preview([line(nav, 1), line(out, 1)], { freeSelections: [pick(out, 1)] });
    expect(res.body.data.offer.freeUnits).toBe(0);
    expect(res.body.data.hasIssues).toBe(true);
  });

  it("checkout charges exactly the previewed total, records the free item, and refuses a forged expectation", async () => {
    await liveOffer();
    const items = [line(nav, 1), line(mixed, 1)];
    const sel = { freeSelections: [pick(mixed, 1)] };
    const shown = (await preview(items, sel)).body.data;
    const address = await request(app).post("/api/addresses").set("Cookie", cookie(customer)).send({
      label: "Home", receiverName: "Asha Menon", receiverPhone: "9876543210", houseNo: "12",
      area: "Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020",
    });
    const place = (extra: object) =>
      request(app).post("/api/checkout").set("Cookie", cookie(customer)).set("Idempotency-Key", `m-${RUN_ID}-${Math.random().toString(36).slice(2)}`)
        .send({ items, addressId: address.body.data.address.addressId, paymentMethod: "COD", ...sel, ...extra });

    expect((await place({ expectedOfferDiscount: 380 })).status).toBe(409);
    // A dearer pick sent at checkout is simply not free.
    const dearer = await request(app).post("/api/checkout").set("Cookie", cookie(customer)).set("Idempotency-Key", `m-${RUN_ID}-x${Math.random()}`)
      .send({ items: [line(mixed, 1), line(chicken, 1)], addressId: address.body.data.address.addressId, paymentMethod: "COD", freeSelections: [pick(chicken, 1)] });
    expect(dearer.status).toBe(201);
    const dearOrder = await Order.findOne({ userId: customer._id }).sort({ createdAt: -1 }).lean();
    expect(dearOrder!.pricing.offerDiscountTotal ?? 0).toBe(0);

    const ok = await place({ expectedOfferDiscount: shown.offer.discountAmount });
    expect(ok.status).toBe(201);
    const order = await Order.findOne({ userId: customer._id }).sort({ createdAt: -1 }).lean();
    expect(order!.pricing).toMatchObject({ subtotal: 380, offerDiscountTotal: 190 });
    expect(order!.pricing.grandTotal).toBeCloseTo(380 - 190 + order!.pricing.shippingFee + (order!.pricing.taxTotal ?? 0), 2);
    expect(order!.offer!.freeItems.map((f) => f.productId.toString())).toEqual([id(mixed)]);
  });
});

describe("admin configuration", () => {
  const create = (over: Record<string, unknown>) => request(app).post("/api/admin/offers").set("Cookie", cookie(admin)).send(offerBody(over));

  it("rejects rules for a product that isn't eligible, duplicates, and rules on non-BOGO offers", async () => {
    const stranger = await makeProduct("Stranger", 100);
    const notEligible = await create({ freeProductRules: [{ buyProductId: id(stranger), freeProductIds: [id(nav)] }] });
    expect(notEligible.status).toBe(400);
    const dup = await create({
      freeProductRules: [
        { buyProductId: id(nav), freeProductIds: [id(mixed)] },
        { buyProductId: id(nav), freeProductIds: [id(broc)] },
      ],
    });
    expect(dup.status).toBe(400);
    const pct = await create({ type: "PERCENTAGE", discountPercent: 10, freeProductIds: [] });
    expect(pct.status).toBe(400);
  });

  it("returns the rules with product details", async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    offerIds.push(new mongoose.Types.ObjectId(res.body.data.offer.id));
    const rule = res.body.data.offer.freeProductRules.find((r: { buyProduct: { id: string } }) => r.buyProduct.id === id(broc));
    expect(rule.freeProducts.map((p: { id: string }) => p.id).sort()).toEqual([id(nav), id(mixed)].sort());
  });
});
