import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Category, Brand, Product } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdCategoryIds: mongoose.Types.ObjectId[] = [];
const createdBrandIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeAdmin() {
  const user = await User.create({
    phone: `76${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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

async function makeCategory() {
  const category = await Category.create({
    name: `PackAdmin Cat ${RUN_ID}-${createdCategoryIds.length}`,
    slug: `packadmin-cat-${RUN_ID}-${createdCategoryIds.length}`,
  });
  createdCategoryIds.push(category._id);
  return category;
}

async function makeProduct(categoryId: mongoose.Types.ObjectId) {
  const brand = await Brand.create({
    name: `PackAdmin Brand ${RUN_ID}-${createdBrandIds.length}`,
    slug: `packadmin-brand-${RUN_ID}-${createdBrandIds.length}`,
  });
  createdBrandIds.push(brand._id);

  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Navadhanya ${RUN_ID}-${n}`,
    slug: `navadhanya-${RUN_ID}-${n}`,
    sku: `NAV-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId,
    brandId: brand._id,
    pricing: { mrp: 120, sellingPrice: 100 },
    inventory: { stockQuantity: 500, lowStockThreshold: 10, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["navadhanya"] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await Category.deleteMany({ _id: { $in: createdCategoryIds } });
  await Brand.deleteMany({ _id: { $in: createdBrandIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Admin pack CRUD (/admin/products/:id/packs)", () => {
  it("creates, lists, updates and deletes a pack", async () => {
    const admin = await makeAdmin();
    const category = await makeCategory();
    const product = await makeProduct(category._id);
    const cookie = authCookie(admin);

    const created = await request(app)
      .post(`/api/admin/products/${product._id}/packs`)
      .set("Cookie", cookie)
      .send({ name: "Pack of 5", quantity: 5, price: 450, sku: `PK5-${RUN_ID}` });
    expect(created.status).toBe(201);
    expect(created.body.data.pack).toMatchObject({ name: "Pack of 5", quantity: 5, price: 450 });
    // Derived, never stored: discount = 5*120 - 450 = 150.
    expect(created.body.data.pack.discount).toBe(150);
    const packId = created.body.data.pack.packId;

    const list = await request(app)
      .get(`/api/admin/products/${product._id}/packs`)
      .set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.packs).toHaveLength(1);

    const updated = await request(app)
      .put(`/api/admin/products/${product._id}/packs/${packId}`)
      .set("Cookie", cookie)
      .send({ price: 425 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.pack.price).toBe(425);

    const deleted = await request(app)
      .delete(`/api/admin/products/${product._id}/packs/${packId}`)
      .set("Cookie", cookie);
    expect(deleted.status).toBe(200);

    const afterDelete = await request(app)
      .get(`/api/admin/products/${product._id}/packs`)
      .set("Cookie", cookie);
    expect(afterDelete.body.data.packs).toHaveLength(0);
  });

  it("rejects a duplicate SKU within the same product", async () => {
    const admin = await makeAdmin();
    const category = await makeCategory();
    const product = await makeProduct(category._id);
    const cookie = authCookie(admin);

    await request(app)
      .post(`/api/admin/products/${product._id}/packs`)
      .set("Cookie", cookie)
      .send({ name: "Pack of 5", quantity: 5, price: 450, sku: `DUP-${RUN_ID}` });

    const dup = await request(app)
      .post(`/api/admin/products/${product._id}/packs`)
      .set("Cookie", cookie)
      .send({ name: "Pack of 10", quantity: 10, price: 850, sku: `DUP-${RUN_ID}` });
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid pack payload (quantity <= 0)", async () => {
    const admin = await makeAdmin();
    const category = await makeCategory();
    const product = await makeProduct(category._id);

    const res = await request(app)
      .post(`/api/admin/products/${product._id}/packs`)
      .set("Cookie", authCookie(admin))
      .send({ name: "Bad pack", quantity: 0, price: 100 });
    expect(res.status).toBe(400);
  });

  it("updates pack-config settings (enable, strategy, mixed packs)", async () => {
    const admin = await makeAdmin();
    const category = await makeCategory();
    const product = await makeProduct(category._id);
    const cookie = authCookie(admin);

    const res = await request(app)
      .patch(`/api/admin/products/${product._id}/pack-config`)
      .set("Cookie", cookie)
      .send({ enabled: true, mixedPacksAllowed: false, recommendationStrategy: "CHEAPEST" });
    expect(res.status).toBe(200);
    expect(res.body.data.packConfig).toMatchObject({
      enabled: true,
      mixedPacksAllowed: false,
      recommendationStrategy: "CHEAPEST",
    });

    const fresh = await Product.findById(product._id).lean();
    expect(fresh!.packConfig?.enabled).toBe(true);
  });
});

describe("Category-level pack config + inheritance (spec §15/§16)", () => {
  it("a product in INHERIT_CATEGORY mode resolves packs from its category on the public catalog", async () => {
    const admin = await makeAdmin();
    const category = await makeCategory();
    const cookie = authCookie(admin);

    await request(app)
      .patch(`/api/admin/categories/${category._id}/pack-config`)
      .set("Cookie", cookie)
      .send({ enabled: true, recommendationStrategy: "ADMIN_PRIORITY" });
    await request(app)
      .post(`/api/admin/categories/${category._id}/packs`)
      .set("Cookie", cookie)
      .send({ name: "Pack of 10", quantity: 10, price: 900 });

    const product = await makeProduct(category._id);
    await request(app)
      .patch(`/api/admin/products/${product._id}/pack-config`)
      .set("Cookie", cookie)
      .send({ enabled: true, mode: "INHERIT_CATEGORY" });

    const publicRes = await request(app).get(`/api/products/${product.slug}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data.product.packOptions).toHaveLength(1);
    expect(publicRes.body.data.product.packOptions[0]).toMatchObject({ name: "Pack of 10", quantity: 10, price: 900 });
  });

  it("a product that never enables packs shows no packOptions — existing products are unaffected (spec §22)", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category._id);

    const publicRes = await request(app).get(`/api/products/${product.slug}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data.product.packOptions).toEqual([]);
  });
});
