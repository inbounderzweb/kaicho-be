import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, Category, Brand, Product } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { createProduct, updateProductById } from "../../product/product.service";
import type { CreateProductInput } from "../../product/product.validation";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdMediaIds: mongoose.Types.ObjectId[] = [];
const createdCategoryIds: mongoose.Types.ObjectId[] = [];
const createdBrandIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser() {
  const user = await User.create({
    phone: `8${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

async function makeMedia(uploaderId: mongoose.Types.ObjectId) {
  const media = await Media.create({
    mediaType: "IMAGE",
    storageProvider: "local",
    storageKey: `images/wishlist-test/${RUN_ID}-${createdMediaIds.length}`,
    originalName: "product.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: 100,
    status: "TEMPORARY",
    uploadedBy: uploaderId,
  });
  createdMediaIds.push(media._id);
  return media;
}

async function makeProduct(overrides: Partial<CreateProductInput> = {}) {
  const admin = await makeUser();
  const category = await Category.create({
    name: `WishlistCat-${RUN_ID}-${createdCategoryIds.length}`,
    slug: `wishlist-cat-${RUN_ID}-${createdCategoryIds.length}`,
    isActive: true,
  });
  createdCategoryIds.push(category._id);
  const brand = await Brand.create({
    name: `WishlistBrand-${RUN_ID}-${createdBrandIds.length}`,
    slug: `wishlist-brand-${RUN_ID}-${createdBrandIds.length}`,
    isActive: true,
  });
  createdBrandIds.push(brand._id);
  const media = await makeMedia(admin._id);
  const n = createdProductIds.length;

  const created = await createProduct({
    name: `Wishlist Product ${RUN_ID}-${n}`,
    sku: `WL-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "Longer detailed description of the product for the page.",
    categoryId: category._id.toString(),
    brandId: brand._id.toString(),
    mediaIds: [media._id.toString()],
    pricing: { mrp: 500, sellingPrice: 400, costPrice: 250 },
    inventory: { stockQuantity: 20, lowStockThreshold: 5, trackInventory: true },
    seo: {
      title: "A properly sized SEO title for the product page",
      description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
      keywords: ["wishlist test"],
    },
    ...overrides,
  } as CreateProductInput);
  createdProductIds.push(new mongoose.Types.ObjectId(created!.productId));
  return created!;
}

// DRAFT is the default status createProduct leaves a product in — this
// helper deliberately never activates it, for the "not publicly visible"
// test cases.
async function makeDraftProduct() {
  const admin = await makeUser();
  const category = await Category.create({
    name: `WishlistDraftCat-${RUN_ID}-${createdCategoryIds.length}`,
    slug: `wishlist-draft-cat-${RUN_ID}-${createdCategoryIds.length}`,
    isActive: true,
  });
  createdCategoryIds.push(category._id);
  const brand = await Brand.create({
    name: `WishlistDraftBrand-${RUN_ID}-${createdBrandIds.length}`,
    slug: `wishlist-draft-brand-${RUN_ID}-${createdBrandIds.length}`,
    isActive: true,
  });
  createdBrandIds.push(brand._id);
  const media = await makeMedia(admin._id);
  const n = createdProductIds.length;

  const created = await createProduct({
    name: `Wishlist Draft Product ${RUN_ID}-${n}`,
    sku: `WL-DRAFT-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "Longer detailed description of the product for the page.",
    categoryId: category._id.toString(),
    brandId: brand._id.toString(),
    mediaIds: [media._id.toString()],
    pricing: { mrp: 500, sellingPrice: 400, costPrice: 250 },
    inventory: { stockQuantity: 20, lowStockThreshold: 5, trackInventory: true },
    seo: {
      title: "A properly sized SEO title for the product page",
      description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
      keywords: ["wishlist draft test"],
    },
  } as CreateProductInput);
  createdProductIds.push(new mongoose.Types.ObjectId(created!.productId));
  return created!;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await Brand.deleteMany({ _id: { $in: createdBrandIds } });
  await Category.deleteMany({ _id: { $in: createdCategoryIds } });
  await Media.deleteMany({ _id: { $in: createdMediaIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Wishlist API — auth requirement", () => {
  it("401s on GET /api/wishlist without a session", async () => {
    const res = await request(app).get("/api/wishlist");
    expect(res.status).toBe(401);
  });

  it("401s on POST /api/wishlist/:productId without a session", async () => {
    const res = await request(app).post(`/api/wishlist/${new mongoose.Types.ObjectId().toString()}`);
    expect(res.status).toBe(401);
  });

  it("401s on DELETE /api/wishlist/:productId without a session", async () => {
    const res = await request(app).delete(`/api/wishlist/${new mongoose.Types.ObjectId().toString()}`);
    expect(res.status).toBe(401);
  });
});

describe("Wishlist API — authenticated", () => {
  it("starts empty for a new user", async () => {
    const user = await makeUser();
    const res = await request(app).get("/api/wishlist").set("Cookie", authCookie(user));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it("adds a publicly-visible (ACTIVE) product and reflects it in the list", async () => {
    const user = await makeUser();
    const product = await makeProduct();
    await updateProductById(product.productId, { status: "ACTIVE" });

    const addRes = await request(app)
      .post(`/api/wishlist/${product.productId}`)
      .set("Cookie", authCookie(user));
    expect(addRes.status).toBe(200);
    const slugs = addRes.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(product.slug);

    const getRes = await request(app).get("/api/wishlist").set("Cookie", authCookie(user));
    expect(getRes.body.data.items.map((p: { slug: string }) => p.slug)).toContain(product.slug);
  });

  it("adding the same product twice is idempotent (no duplicate entries)", async () => {
    const user = await makeUser();
    const product = await makeProduct();
    await updateProductById(product.productId, { status: "ACTIVE" });

    await request(app).post(`/api/wishlist/${product.productId}`).set("Cookie", authCookie(user));
    const res = await request(app).post(`/api/wishlist/${product.productId}`).set("Cookie", authCookie(user));
    const matches = res.body.data.items.filter((p: { slug: string }) => p.slug === product.slug);
    expect(matches).toHaveLength(1);
  });

  it("rejects an invalid (non-ObjectId) productId with 400", async () => {
    const user = await makeUser();
    const res = await request(app).post("/api/wishlist/not-a-valid-id").set("Cookie", authCookie(user));
    expect(res.status).toBe(400);
  });

  it("404s adding a nonexistent product", async () => {
    const user = await makeUser();
    const res = await request(app)
      .post(`/api/wishlist/${new mongoose.Types.ObjectId().toString()}`)
      .set("Cookie", authCookie(user));
    expect(res.status).toBe(404);
  });

  it("404s adding a DRAFT (not publicly visible) product", async () => {
    const user = await makeUser();
    const draft = await makeDraftProduct();
    const res = await request(app).post(`/api/wishlist/${draft.productId}`).set("Cookie", authCookie(user));
    expect(res.status).toBe(404);
  });

  it("removes a product from the wishlist", async () => {
    const user = await makeUser();
    const product = await makeProduct();
    await updateProductById(product.productId, { status: "ACTIVE" });
    await request(app).post(`/api/wishlist/${product.productId}`).set("Cookie", authCookie(user));

    const removeRes = await request(app)
      .delete(`/api/wishlist/${product.productId}`)
      .set("Cookie", authCookie(user));
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.data.items.map((p: { slug: string }) => p.slug)).not.toContain(product.slug);
  });

  it("one user's wishlist is isolated from another's", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const product = await makeProduct();
    await updateProductById(product.productId, { status: "ACTIVE" });

    await request(app).post(`/api/wishlist/${product.productId}`).set("Cookie", authCookie(userA));
    const resB = await request(app).get("/api/wishlist").set("Cookie", authCookie(userB));
    expect(resB.body.data.items).toEqual([]);
  });
});
