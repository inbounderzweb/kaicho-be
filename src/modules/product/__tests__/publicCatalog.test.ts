import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, Category, Brand, Product } from "../../../database/models";
import { createProduct, updateProductById } from "../product.service";
import type { CreateProductInput } from "../product.validation";

// Covers the customer-facing /api/products, /api/categories, /api/brands
// surface (productPublic/categoryPublic/brandPublic .routes.ts) — separate
// from product.test.ts, which exercises the /api/admin/products CRUD
// surface. Key things asserted here that the admin tests don't cover:
// DRAFT/inactive entities never leak through the public routes, no
// admin-only fields (costPrice, createdBy/updatedBy, raw status) appear in
// the public DTOs, and query params are constrained to known-safe values.

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdMediaIds: mongoose.Types.ObjectId[] = [];
const createdCategoryIds: mongoose.Types.ObjectId[] = [];
const createdBrandIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser() {
  const user = await User.create({
    phone: `7${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "admin",
  });
  createdUserIds.push(user._id);
  return user;
}

async function makeMedia() {
  const uploader = await makeUser();
  const media = await Media.create({
    mediaType: "IMAGE",
    storageProvider: "local",
    storageKey: `images/public-catalog-test/${RUN_ID}-${createdMediaIds.length}`,
    originalName: "product.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: 100,
    status: "TEMPORARY",
    uploadedBy: uploader._id,
  });
  createdMediaIds.push(media._id);
  return media;
}

async function makeCategory(overrides: Partial<{ isActive: boolean; name: string }> = {}) {
  const n = createdCategoryIds.length;
  const category = await Category.create({
    name: overrides.name ?? `PublicCat-${RUN_ID}-${n}`,
    slug: `public-cat-${RUN_ID}-${n}`,
    isActive: overrides.isActive ?? true,
  });
  createdCategoryIds.push(category._id);
  return category;
}

async function makeBrand(overrides: Partial<{ isActive: boolean }> = {}) {
  const n = createdBrandIds.length;
  const brand = await Brand.create({
    name: `PublicBrand-${RUN_ID}-${n}`,
    slug: `public-brand-${RUN_ID}-${n}`,
    isActive: overrides.isActive ?? true,
  });
  createdBrandIds.push(brand._id);
  return brand;
}

async function makeActiveProduct(
  overrides: Partial<CreateProductInput> & { categoryId?: string; brandId?: string } = {}
) {
  const category = overrides.categoryId ? null : await makeCategory();
  const brand = overrides.brandId ? null : await makeBrand();
  const media = await makeMedia();
  const n = createdProductIds.length;
  const input: CreateProductInput = {
    name: `Public Product ${RUN_ID}-${n}`,
    sku: `PUB-SKU-${RUN_ID}-${n}`,
    shortDescription: "A short description of the product.",
    description: "A longer, detailed description of the product for the product page.",
    categoryId: overrides.categoryId ?? category!._id.toString(),
    brandId: overrides.brandId ?? brand!._id.toString(),
    mediaIds: [media._id.toString()],
    pricing: { mrp: 500, sellingPrice: 400, costPrice: 250 },
    inventory: { stockQuantity: 50, lowStockThreshold: 10, trackInventory: true },
    seo: {
      title: "A properly sized SEO title for the product page",
      description:
        "A properly sized SEO meta description that falls within the accepted length bounds for validation.",
      keywords: ["oats porridge", "healthy breakfast"],
    },
    ...overrides,
  } as CreateProductInput;

  const created = await createProduct(input);
  createdProductIds.push(new mongoose.Types.ObjectId(created!.productId));
  const activated = await updateProductById(created!.productId, { status: "ACTIVE" });
  return { product: activated!, categoryId: input.categoryId, brandId: input.brandId };
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

describe("GET /api/products (public listing)", () => {
  it("lists only ACTIVE/OUT_OF_STOCK products, never DRAFT", async () => {
    const { product: active } = await makeActiveProduct();
    const draftInput = await makeActiveProduct();
    // Push a second product back to DRAFT to prove it disappears from the
    // public list even though it was briefly ACTIVE.
    await updateProductById(draftInput.product.productId, { status: "INACTIVE" });

    const res = await request(app).get("/api/products").query({ search: `Public Product ${RUN_ID}` });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const slugs = res.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(active.slug);
    expect(slugs).not.toContain(draftInput.product.slug);
  });

  it("never exposes admin-only fields (costPrice, createdBy, raw status enum)", async () => {
    await makeActiveProduct();
    const res = await request(app).get("/api/products").query({ search: `Public Product ${RUN_ID}` });
    const item = res.body.data.items[0];
    expect(item).toBeDefined();
    expect(item.pricing.costPrice).toBeUndefined();
    expect(item.status).toBeUndefined();
    expect(item.createdBy).toBeUndefined();
    expect(item.updatedBy).toBeUndefined();
    expect(item.sku).toBeUndefined();
  });

  it("defaults to pageSize 24 and caps an oversized pageSize at the max", async () => {
    const res = await request(app).get("/api/products");
    expect(res.body.data.pageSize).toBe(24);

    const capped = await request(app).get("/api/products").query({ pageSize: "500" });
    expect(capped.body.data.pageSize).toBeLessThanOrEqual(60);
  });

  it("filters by categorySlug", async () => {
    const category = await makeCategory();
    const { product } = await makeActiveProduct({ categoryId: category._id.toString() });
    const res = await request(app).get("/api/products").query({ category: category.slug });
    const slugs = res.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(product.slug);
  });

  it("an unknown categorySlug yields an empty grid, not an error", async () => {
    const res = await request(app).get("/api/products").query({ category: "does-not-exist-slug" });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("filters by min/max price", async () => {
    const { product } = await makeActiveProduct({ pricing: { mrp: 1000, sellingPrice: 900, costPrice: 500 } });
    const res = await request(app).get("/api/products").query({ minPrice: "850", maxPrice: "950" });
    const slugs = res.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(product.slug);
  });

  it("filters inStock=true to exclude zero-stock products", async () => {
    const { product } = await makeActiveProduct({
      inventory: { stockQuantity: 0, lowStockThreshold: 10, trackInventory: true },
    });
    const res = await request(app).get("/api/products").query({ inStock: "true", search: product.name });
    const slugs = res.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).not.toContain(product.slug);
  });

  it("sorts by price ascending/descending", async () => {
    const category = await makeCategory();
    const { product: cheap } = await makeActiveProduct({
      categoryId: category._id.toString(),
      pricing: { mrp: 100, sellingPrice: 90, costPrice: 50 },
    });
    const { product: pricey } = await makeActiveProduct({
      categoryId: category._id.toString(),
      pricing: { mrp: 1000, sellingPrice: 950, costPrice: 500 },
    });

    const asc = await request(app)
      .get("/api/products")
      .query({ category: category.slug, sort: "price", order: "asc" });
    const ascSlugs = asc.body.data.items.map((p: { slug: string }) => p.slug);
    expect(ascSlugs.indexOf(cheap.slug)).toBeLessThan(ascSlugs.indexOf(pricey.slug));

    const desc = await request(app)
      .get("/api/products")
      .query({ category: category.slug, sort: "price", order: "desc" });
    const descSlugs = desc.body.data.items.map((p: { slug: string }) => p.slug);
    expect(descSlugs.indexOf(pricey.slug)).toBeLessThan(descSlugs.indexOf(cheap.slug));
  });

  it("ignores an unrecognized sort value rather than passing it to MongoDB", async () => {
    const res = await request(app).get("/api/products").query({ sort: "$where" });
    expect(res.status).toBe(200);
    expect(res.body.data.sort).toBe("relevance");
  });
});

describe("GET /api/products/:slug (public detail)", () => {
  it("returns full detail for an ACTIVE product with images and SEO", async () => {
    const { product } = await makeActiveProduct();
    const res = await request(app).get(`/api/products/${product.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.product.slug).toBe(product.slug);
    expect(res.body.data.product.images.length).toBeGreaterThan(0);
    expect(res.body.data.product.seo.title).toBeTruthy();
    expect(res.body.data.product.pricing.costPrice).toBeUndefined();
  });

  it("404s for a DRAFT product's slug", async () => {
    const category = await makeCategory();
    const brand = await makeBrand();
    const media = await makeMedia();
    const draft = await createProduct({
      name: `Draft Product ${RUN_ID}`,
      sku: `DRAFT-SKU-${RUN_ID}`,
      shortDescription: "Short.",
      description: "Longer description.",
      categoryId: category._id.toString(),
      brandId: brand._id.toString(),
      mediaIds: [media._id.toString()],
      pricing: { mrp: 100, sellingPrice: 90, costPrice: 40 },
      inventory: { stockQuantity: 10, lowStockThreshold: 5, trackInventory: true },
      seo: {
        title: "A properly sized SEO title for the product page",
        description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
        keywords: ["draft"],
      },
    } as CreateProductInput);
    createdProductIds.push(new mongoose.Types.ObjectId(draft!.productId));

    const res = await request(app).get(`/api/products/${draft!.slug}`);
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent slug", async () => {
    const res = await request(app).get("/api/products/this-slug-does-not-exist-anywhere");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/products/:slug/related", () => {
  it("returns same-category products, excluding the source product itself", async () => {
    const category = await makeCategory();
    const { product: source } = await makeActiveProduct({ categoryId: category._id.toString() });
    const { product: sibling } = await makeActiveProduct({ categoryId: category._id.toString() });

    const res = await request(app).get(`/api/products/${source.slug}/related`);
    expect(res.status).toBe(200);
    const slugs = res.body.data.products.map((p: { slug: string }) => p.slug);
    expect(slugs).not.toContain(source.slug);
    expect(slugs).toContain(sibling.slug);
  });
});

describe("GET /api/categories (public)", () => {
  it("lists only active categories", async () => {
    const active = await makeCategory();
    const inactive = await makeCategory({ isActive: false });

    const res = await request(app).get("/api/categories");
    const slugs = res.body.data.categories.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain(active.slug);
    expect(slugs).not.toContain(inactive.slug);
  });

  it("404s for an unknown category slug", async () => {
    const res = await request(app).get("/api/categories/no-such-category-slug");
    expect(res.status).toBe(404);
  });

  it("GET /api/categories/:slug/products scopes the product grid to that category", async () => {
    const category = await makeCategory();
    const { product } = await makeActiveProduct({ categoryId: category._id.toString() });
    const other = await makeActiveProduct();

    const res = await request(app).get(`/api/categories/${category.slug}/products`);
    expect(res.status).toBe(200);
    const slugs = res.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(product.slug);
    expect(slugs).not.toContain(other.product.slug);
  });
});

describe("GET /api/brands (public)", () => {
  it("lists only active brands", async () => {
    const active = await makeBrand();
    const inactive = await makeBrand({ isActive: false });

    const res = await request(app).get("/api/brands");
    const slugs = res.body.data.brands.map((b: { slug: string }) => b.slug);
    expect(slugs).toContain(active.slug);
    expect(slugs).not.toContain(inactive.slug);
  });
});
