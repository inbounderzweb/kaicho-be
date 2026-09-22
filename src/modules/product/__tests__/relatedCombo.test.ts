import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { resolveRelatedCombo } from "../relatedCombo.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeAdmin() {
  const user = await User.create({
    phone: `79${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "admin",
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

async function makeBaseProduct(name: string) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `${name} ${RUN_ID}-${n}`,
    slug: `${name.toLowerCase()}-${RUN_ID}-${n}`,
    sku: `RC-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 120, sellingPrice: 100 },
    inventory: { stockQuantity: 50, lowStockThreshold: 5, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: [name.toLowerCase()] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

async function makeComboProduct(
  name: string,
  components: { productId: mongoose.Types.ObjectId; quantity: number }[],
  overrides: { status?: "ACTIVE" | "DRAFT" } = {}
) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `${name} ${RUN_ID}-${n}`,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}-${n}`,
    sku: `RC-COMBO-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1200, sellingPrice: 1000 },
    inventory: { stockQuantity: 0, lowStockThreshold: 5, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["combo"] },
    status: overrides.status ?? "ACTIVE",
    inventoryTracking: { enabled: true, components },
  });
  createdProductIds.push(product._id);
  return product;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("resolveRelatedCombo — AUTO (default, no admin config)", () => {
  it("finds the combo that lists this product as a component", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya");
    const combo = await makeComboProduct("Navadhanya Combo", [{ productId: navadhanya._id, quantity: 2 }]);

    const suggestion = await resolveRelatedCombo(navadhanya);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.comboProductId).toBe(combo._id.toString());
    expect(suggestion!.price).toBe(1000);
  });

  it("returns null when no combo references this product", async () => {
    const lonely = await makeBaseProduct("Lonely");
    expect(await resolveRelatedCombo(lonely)).toBeNull();
  });

  it("ignores an inactive combo", async () => {
    const millet = await makeBaseProduct("Millet");
    await makeComboProduct("Draft Combo", [{ productId: millet._id, quantity: 1 }], { status: "DRAFT" });
    expect(await resolveRelatedCombo(millet)).toBeNull();
  });
});

describe("resolveRelatedCombo — NONE suppresses even an existing match", () => {
  it("returns null when mode is NONE", async () => {
    const ragi = await makeBaseProduct("Ragi");
    await makeComboProduct("Ragi Combo", [{ productId: ragi._id, quantity: 1 }]);
    ragi.relatedCombo = { mode: "NONE" } as never;
    await ragi.save();

    expect(await resolveRelatedCombo(ragi)).toBeNull();
  });
});

describe("resolveRelatedCombo — MANUAL requires an actual component link", () => {
  it("ignores a manually-pinned product that does not contain the source product", async () => {
    const oats = await makeBaseProduct("Oats");
    const unrelatedBundle = await makeBaseProduct("Festival Gift Box"); // no inventoryTracking at all
    oats.relatedCombo = { mode: "MANUAL", comboProductId: unrelatedBundle._id } as never;
    await oats.save();

    const suggestion = await resolveRelatedCombo(oats);
    expect(suggestion).toBeNull();
  });

  it("falls back to null (not a crash) when the pinned target is gone/inactive", async () => {
    const wheat = await makeBaseProduct("Wheat");
    const fakeId = new mongoose.Types.ObjectId();
    wheat.relatedCombo = { mode: "MANUAL", comboProductId: fakeId } as never;
    await wheat.save();

    expect(await resolveRelatedCombo(wheat)).toBeNull();
  });
});

describe("GET /api/products/:slug includes relatedCombo", () => {
  it("is present when an AUTO match exists, and null on an unrelated product", async () => {
    const navadhanya = await makeBaseProduct("PublicNavadhanya");
    const combo = await makeComboProduct("PublicCombo", [{ productId: navadhanya._id, quantity: 2 }]);
    const lonely = await makeBaseProduct("PublicLonely");

    const withCombo = await request(app).get(`/api/products/${navadhanya.slug}`);
    expect(withCombo.status).toBe(200);
    expect(withCombo.body.data.product.relatedCombo?.comboProductId).toBe(combo._id.toString());

    const withoutCombo = await request(app).get(`/api/products/${lonely.slug}`);
    expect(withoutCombo.status).toBe(200);
    expect(withoutCombo.body.data.product.relatedCombo).toBeNull();
  });
});

describe("Admin CRUD /admin/products/:id/related-combo", () => {
  it("reads defaults, then sets MANUAL and clears back to AUTO", async () => {
    const admin = await makeAdmin();
    const cookie = authCookie(admin);
    const product = await makeBaseProduct("AdminManaged");
    const bundle = await makeComboProduct("AdminBundle", [{ productId: product._id, quantity: 2 }]);

    const defaults = await request(app).get(`/api/admin/products/${product._id}/related-combo`).set("Cookie", cookie);
    expect(defaults.status).toBe(200);
    expect(defaults.body.data.relatedCombo).toEqual({ mode: "AUTO" });

    const setManual = await request(app)
      .patch(`/api/admin/products/${product._id}/related-combo`)
      .set("Cookie", cookie)
      .send({ mode: "MANUAL", comboProductId: bundle._id.toString() });
    expect(setManual.status).toBe(200);
    expect(setManual.body.data.relatedCombo).toEqual({
      mode: "MANUAL",
      comboProductId: bundle._id.toString(),
      comboProductName: bundle.name,
    });

    const clear = await request(app)
      .patch(`/api/admin/products/${product._id}/related-combo`)
      .set("Cookie", cookie)
      .send({ mode: "AUTO", comboProductId: null });
    expect(clear.status).toBe(200);
    expect(clear.body.data.relatedCombo).toEqual({ mode: "AUTO" });
  });

  it("rejects pointing a product at itself", async () => {
    const admin = await makeAdmin();
    const product = await makeBaseProduct("SelfRef");

    const res = await request(app)
      .patch(`/api/admin/products/${product._id}/related-combo`)
      .set("Cookie", authCookie(admin))
      .send({ mode: "MANUAL", comboProductId: product._id.toString() });
    expect(res.status).toBe(400);
  });
});
