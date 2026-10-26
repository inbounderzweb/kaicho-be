import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Offer, OfferActivity, OfferUsage } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureOfferIndexes } from "../offer.indexes";

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const productIds: mongoose.Types.ObjectId[] = [];
const offerIds: mongoose.Types.ObjectId[] = [];
let userSeq = 0;
let seq = 0;

async function makeUser(role: "user" | "admin") {
  const u = await User.create({
    phone: `79${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  userIds.push(u._id);
  return u;
}
const cookie = (u: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(u)}`;

async function makeProduct(price = 180) {
  const n = seq++;
  const p = await Product.create({
    name: `AdminOffer Product ${RUN_ID}-${n}`,
    slug: `adminoffer-product-${RUN_ID}-${n}`,
    sku: `AOF-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: price + 50, sellingPrice: price },
    inventory: { stockQuantity: 50, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["offer"] },
    status: "ACTIVE",
  });
  productIds.push(p._id);
  return p;
}

let admin: InstanceType<typeof User>;
let customer: InstanceType<typeof User>;

beforeAll(async () => {
  await connectDatabase();
  await ensureOfferIndexes();
  admin = await makeUser("admin");
  customer = await makeUser("user");
});

afterAll(async () => {
  await OfferUsage.deleteMany({ offerId: { $in: offerIds } });
  await OfferActivity.deleteMany({ offerId: { $in: offerIds } });
  await Offer.deleteMany({ _id: { $in: offerIds } });
  await Product.deleteMany({ _id: { $in: productIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

async function createOffer(body: Record<string, unknown>) {
  const res = await request(app).post("/api/admin/offers").set("Cookie", cookie(admin)).send(body);
  if (res.status === 201) offerIds.push(new mongoose.Types.ObjectId(res.body.data.offer.id));
  return res;
}
const validBody = (productId: string, over: Record<string, unknown> = {}) => ({
  name: `Admin BOGO ${RUN_ID}-${seq++}`,
  type: "BOGO",
  eligibleProductIds: [productId],
  // A BOGO offer must say what is free; here the bought product is also the free one.
  freeProductIds: [productId],
  maxFreeUnitsPerOrder: 2,
  ...over,
});

describe("admin offers — authorization", () => {
  it("rejects anonymous requests (401) and customers (403) on every mutation", async () => {
    const p = await makeProduct();
    expect((await request(app).get("/api/admin/offers")).status).toBe(401);
    expect((await request(app).post("/api/admin/offers")).status).toBe(401);
    const asCustomer = await request(app).post("/api/admin/offers").set("Cookie", cookie(customer)).send(validBody(p._id.toString()));
    expect(asCustomer.status).toBe(403);
    const created = await createOffer(validBody(p._id.toString()));
    const id = created.body.data.offer.id;
    for (const [method, url, body] of [
      ["patch", `/api/admin/offers/${id}`, { name: "x" }],
      ["post", `/api/admin/offers/${id}/status`, { status: "ACTIVE" }],
      ["post", `/api/admin/offers/${id}/simulate`, { items: [{ productId: p._id.toString(), quantity: 2 }] }],
    ] as const) {
      const res = await request(app)[method](url).set("Cookie", cookie(customer)).send(body);
      expect(res.status).toBe(403);
    }
  });
});

describe("admin offers — create / validate", () => {
  it("creates a DRAFT BOGO offer with defaults and an audit row", async () => {
    const p = await makeProduct();
    const res = await createOffer(validBody(p._id.toString()));
    expect(res.status).toBe(201);
    expect(res.body.data.offer).toMatchObject({
      type: "BOGO",
      status: "DRAFT",
      effectiveStatus: "DRAFT",
      buyQuantity: 1,
      maxFreeUnitsPerOrder: 2,
      allowCouponStacking: false,
    });
    expect(res.body.data.offer.eligibleProducts[0].id).toBe(p._id.toString());
    expect(res.body.data.offer.activity[0].action).toBe("CREATED");
  });

  it("requires explicit eligibility (no products/categories and not applyToAll)", async () => {
    const res = await createOffer({ name: "No scope", maxFreeUnitsPerOrder: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects an end date before the start date, bad caps and negative minimum price", async () => {
    const p = await makeProduct();
    const id = p._id.toString();
    expect((await createOffer(validBody(id, { startsAt: "2030-01-02", endsAt: "2030-01-01" }))).status).toBe(400);
    expect((await createOffer(validBody(id, { maxFreeUnitsPerOrder: 0 }))).status).toBe(400);
    expect((await createOffer(validBody(id, { buyQuantity: 0 }))).status).toBe(400);
    expect((await createOffer(validBody(id, { minPaidUnitPrice: -1 }))).status).toBe(400);
    expect((await createOffer(validBody(id, { usageLimit: 1, usageLimitPerUser: 2 }))).status).toBe(400);
  });

  it("rejects an \"all products\" offer — eligibility must be explicit", async () => {
    const p = await makeProduct();
    const res = await createOffer(validBody(p._id.toString(), { applyToAll: true }));
    expect(res.status).toBe(400);
  });

  it("rejects eligible categories — products only", async () => {
    const p = await makeProduct();
    const res = await createOffer(validBody(p._id.toString(), { eligibleCategoryIds: [new mongoose.Types.ObjectId().toString()] }));
    expect(res.status).toBe(400);
  });

  it("rejects references to products that don't exist", async () => {
    const res = await createOffer(validBody(new mongoose.Types.ObjectId().toString()));
    expect(res.status).toBe(400);
  });

  it("SCHEDULED needs a future start and is stored as ACTIVE (effective SCHEDULED)", async () => {
    const p = await makeProduct();
    const bad = await createOffer(validBody(p._id.toString(), { status: "SCHEDULED" }));
    expect(bad.status).toBe(400);
    const ok = await createOffer(validBody(p._id.toString(), { status: "SCHEDULED", startsAt: new Date(Date.now() + 86_400_000).toISOString() }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.offer.status).toBe("ACTIVE");
    expect(ok.body.data.offer.effectiveStatus).toBe("SCHEDULED");
  });
});

describe("admin offers — lifecycle, edit, preview, inspect", () => {
  it("activate → appears on the public API; deactivate → disappears", async () => {
    const p = await makeProduct();
    const created = await createOffer(validBody(p._id.toString()));
    const id = created.body.data.offer.id;

    const before = await request(app).get("/api/offers/active");
    expect(before.body.data.offers.some((o: { id: string }) => o.id === id)).toBe(false);

    const on = await request(app).post(`/api/admin/offers/${id}/status`).set("Cookie", cookie(admin)).send({ status: "ACTIVE" });
    expect(on.status).toBe(200);
    expect(on.body.data.offer.effectiveStatus).toBe("ACTIVE");

    const live = await request(app).get("/api/offers/active");
    const found = live.body.data.offers.find((o: { id: string }) => o.id === id);
    expect(found).toMatchObject({ buyQuantity: 1, maxFreeUnitsPerOrder: 2, eligibleProductIds: [p._id.toString()] });

    const off = await request(app).post(`/api/admin/offers/${id}/status`).set("Cookie", cookie(admin)).send({ status: "DISABLED", note: "paused" });
    expect(off.body.data.offer.effectiveStatus).toBe("DISABLED");
    const after = await request(app).get("/api/offers/active");
    expect(after.body.data.offers.some((o: { id: string }) => o.id === id)).toBe(false);

    const actions = off.body.data.offer.activity.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["CREATED", "ACTIVATED", "DISABLED"]));
  });

  it("an offer past its end date is EXPIRED and is not public even if stored ACTIVE", async () => {
    const o = await Offer.create({
      name: `Expired ${RUN_ID}`,
      status: "ACTIVE",
      eligibleProductIds: [new mongoose.Types.ObjectId()],
      startsAt: new Date(Date.now() - 2 * 86_400_000),
      endsAt: new Date(Date.now() - 86_400_000),
    });
    offerIds.push(o._id);
    const list = await request(app).get("/api/admin/offers?status=EXPIRED").set("Cookie", cookie(admin));
    expect(list.body.data.items.some((i: { id: string }) => i.id === o._id.toString())).toBe(true);
    expect(list.body.data.items.find((i: { id: string }) => i.id === o._id.toString()).effectiveStatus).toBe("EXPIRED");
    const pub = await request(app).get("/api/offers/active");
    expect(pub.body.data.offers.some((x: { id: string }) => x.id === o._id.toString())).toBe(false);
  });

  it("can't activate an offer whose end date has passed", async () => {
    const p = await makeProduct();
    const created = await createOffer(validBody(p._id.toString(), { startsAt: "2020-01-01", endsAt: "2020-02-01" }));
    const res = await request(app).post(`/api/admin/offers/${created.body.data.offer.id}/status`).set("Cookie", cookie(admin)).send({ status: "ACTIVE" });
    expect(res.status).toBe(400);
  });

  it("edits fields, records a before/after diff and validates the merged document", async () => {
    const p = await makeProduct();
    const created = await createOffer(validBody(p._id.toString()));
    const id = created.body.data.offer.id;

    const res = await request(app)
      .patch(`/api/admin/offers/${id}`)
      .set("Cookie", cookie(admin))
      .send({ maxFreeUnitsPerOrder: 5, minPaidUnitPrice: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.offer).toMatchObject({ maxFreeUnitsPerOrder: 5, minPaidUnitPrice: 100 });
    const updated = res.body.data.offer.activity.find((a: { action: string }) => a.action === "UPDATED");
    expect(updated.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "Max free units per order", from: "2", to: "5" })])
    );

    const empty = await request(app).patch(`/api/admin/offers/${id}`).set("Cookie", cookie(admin)).send({});
    expect(empty.status).toBe(400);
    const noScope = await request(app)
      .patch(`/api/admin/offers/${id}`)
      .set("Cookie", cookie(admin))
      .send({ eligibleProductIds: [] });
    expect(noScope.status).toBe(400); // model guard: merged doc has no eligibility
  });

  it("simulates the REAL pairing rule with trusted prices (preview)", async () => {
    const a = await makeProduct(180);
    const dear = await makeProduct(200);
    const pool = [a._id.toString(), dear._id.toString()];
    const created = await createOffer(validBody(a._id.toString(), { eligibleProductIds: pool, freeProductIds: pool }));
    const id = created.body.data.offer.id;

    const ok = await request(app)
      .post(`/api/admin/offers/${id}/simulate`)
      .set("Cookie", cookie(admin))
      .send({ items: [{ productId: a._id.toString(), quantity: 2 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ discountAmount: 180, freeUnits: 1 });

    const bad = await request(app)
      .post(`/api/admin/offers/${id}/simulate`)
      .set("Cookie", cookie(admin))
      .send({
        items: [
          { productId: a._id.toString(), quantity: 1 },
          { productId: dear._id.toString(), quantity: 1 },
        ],
        freeSelections: [{ productId: dear._id.toString(), quantity: 1 }],
      });
    expect(bad.body.data.discountAmount).toBe(0);
    expect(bad.body.data.rejected[0].reason).toBe("PRICE_TOO_HIGH");
  });

  it("lists with search/status filters and exposes usage history", async () => {
    const p = await makeProduct();
    const created = await createOffer(validBody(p._id.toString(), { name: `Findable ${RUN_ID}` }));
    const id = created.body.data.offer.id;
    const list = await request(app).get(`/api/admin/offers?search=Findable%20${RUN_ID}&status=DRAFT`).set("Cookie", cookie(admin));
    expect(list.body.data.items.map((i: { id: string }) => i.id)).toContain(id);
    const usages = await request(app).get(`/api/admin/offers/${id}/usages`).set("Cookie", cookie(admin));
    expect(usages.status).toBe(200);
    expect(usages.body.data).toMatchObject({ total: 0, items: [] });
    expect((await request(app).get("/api/admin/offers/not-an-id").set("Cookie", cookie(admin))).status).toBe(404);
  });
});
