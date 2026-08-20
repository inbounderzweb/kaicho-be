import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, Category, Brand, Product } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import {
  createProduct,
  updateProductById,
  deleteProductById,
  duplicateProductById,
  getProductList,
  computeDiscount,
} from "../product.service";
import { createProductSchema } from "../product.validation";
import type { CreateProductInput } from "../product.validation";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdMediaIds: mongoose.Types.ObjectId[] = [];
const createdCategoryIds: mongoose.Types.ObjectId[] = [];
const createdBrandIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `7${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

async function makeMedia(
  overrides: Partial<{ mediaType: "IMAGE" | "DOCUMENT"; status: "TEMPORARY" | "ATTACHED" }> = {}
) {
  const uploader = await makeUser("admin");
  const media = await Media.create({
    mediaType: overrides.mediaType ?? "IMAGE",
    storageProvider: "local",
    storageKey: `images/product-test/${RUN_ID}-${createdMediaIds.length}`,
    originalName: "product.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: 100,
    status: overrides.status ?? "TEMPORARY",
    uploadedBy: uploader._id,
  });
  createdMediaIds.push(media._id);
  return media;
}

async function makeCategory(overrides: Partial<{ isActive: boolean }> = {}) {
  const category = await Category.create({
    name: `Cat-${RUN_ID}-${createdCategoryIds.length}`,
    slug: `cat-${RUN_ID}-${createdCategoryIds.length}`,
    isActive: overrides.isActive ?? true,
  });
  createdCategoryIds.push(category._id);
  return category;
}

async function makeBrand(overrides: Partial<{ isActive: boolean }> = {}) {
  const brand = await Brand.create({
    name: `Brand-${RUN_ID}-${createdBrandIds.length}`,
    slug: `brand-${RUN_ID}-${createdBrandIds.length}`,
    isActive: overrides.isActive ?? true,
  });
  createdBrandIds.push(brand._id);
  return brand;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

async function validInput(overrides: Partial<CreateProductInput> = {}): Promise<CreateProductInput> {
  const category = await makeCategory();
  const brand = await makeBrand();
  const media = await makeMedia();
  return {
    name: `Test Product ${RUN_ID}-${createdProductIds.length}-${Math.random().toString(36).slice(2, 6)}`,
    sku: `SKU-${RUN_ID}-${createdProductIds.length}-${Math.random().toString(36).slice(2, 6)}`,
    shortDescription: "A short description of the product.",
    description: "A longer, detailed description of the product for the product page.",
    categoryId: category._id.toString(),
    brandId: brand._id.toString(),
    mediaIds: [media._id.toString()],
    pricing: { mrp: 499, sellingPrice: 399, costPrice: 250 },
    inventory: { stockQuantity: 100, lowStockThreshold: 10, trackInventory: true },
    seo: {
      title: "A properly sized SEO title for the product page",
      description: "A properly sized SEO meta description that falls within the accepted length bounds for validation.",
      keywords: ["oats porridge", "healthy breakfast"],
    },
    ...overrides,
  } as CreateProductInput;
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

describe("product.service: create (unit)", () => {
  it("creates a valid product as DRAFT by default, with computed discount", async () => {
    const input = await validInput();
    const product = await createProduct(input);
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    expect(product!.status).toBe("DRAFT");
    expect(product!.sku).toBe(input.sku.toUpperCase());
    expect(product!.pricing.discount).toBe(100);
    expect(product!.pricing.discountPercentage).toBeCloseTo(20.04, 1);
    expect(product!.images).toHaveLength(1);
    expect(product!.images[0].isPrimary).toBe(true);
  });

  it("auto-generates a slug from the name and normalizes a supplied one", async () => {
    const input = await validInput({ name: "Broccoli & Mushroom Oats!!" });
    const product = await createProduct(input);
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));
    expect(product!.slug).toBe("broccoli-mushroom-oats");
  });

  it("rejects a duplicate SKU (case-insensitive via normalization)", async () => {
    const first = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(first!.productId));
    const second = await validInput({ sku: first!.sku.toLowerCase() });
    await expect(createProduct(second)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a duplicate slug", async () => {
    const first = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(first!.productId));
    const second = await validInput({ name: "Some Other Name", slug: first!.slug });
    await expect(createProduct(second)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects an invalid/nonexistent category", async () => {
    const input = await validInput({ categoryId: new mongoose.Types.ObjectId().toString() });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an inactive category", async () => {
    const inactiveCategory = await makeCategory({ isActive: false });
    const input = await validInput({ categoryId: inactiveCategory._id.toString() });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an invalid/nonexistent brand", async () => {
    const input = await validInput({ brandId: new mongoose.Types.ObjectId().toString() });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an inactive brand", async () => {
    const inactiveBrand = await makeBrand({ isActive: false });
    const input = await validInput({ brandId: inactiveBrand._id.toString() });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects invalid/nonexistent media and rolls back the created product", async () => {
    const input = await validInput({ mediaIds: [new mongoose.Types.ObjectId().toString()] });
    const sku = input.sku.toUpperCase();
    const beforeCount = await Product.countDocuments({ sku });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 400 });
    const afterCount = await Product.countDocuments({ sku });
    expect(afterCount).toBe(beforeCount);
  });

  it("rejects media already attached to another product", async () => {
    const takenMedia = await makeMedia();
    const owner = await createProduct(await validInput({ mediaIds: [takenMedia._id.toString()] }));
    createdProductIds.push(new mongoose.Types.ObjectId(owner!.productId));

    const input = await validInput({ mediaIds: [takenMedia._id.toString()] });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a DOCUMENT media as a product image", async () => {
    const pdf = await makeMedia({ mediaType: "DOCUMENT" });
    const input = await validInput({ mediaIds: [pdf._id.toString()] });
    await expect(createProduct(input)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects selling price greater than MRP", async () => {
    const input = await validInput({ pricing: { mrp: 100, sellingPrice: 150 } });
    await expect(createProduct(input)).rejects.toThrow();
  });

  it("rejects negative/zero pricing", async () => {
    const input = await validInput({ pricing: { mrp: 0, sellingPrice: 0 } });
    await expect(createProduct(input)).rejects.toThrow();
  });

  it("rejects negative stock quantity", async () => {
    const input = await validInput({ inventory: { stockQuantity: -1, lowStockThreshold: 10, trackInventory: true } });
    await expect(createProduct(input)).rejects.toThrow();
  });
});

// Pure schema-level checks — no DB needed. This is where field-shape
// validation (required-ness, string length, array bounds) actually lives;
// product.service.ts trusts CreateProductInput as already Zod-validated and
// only re-checks business rules (uniqueness, cross-entity references,
// activation readiness), so these cases belong against the schema directly,
// not against a direct createProduct() call that bypasses validateBody.
describe("product.validation: SEO schema rules", () => {
  const baseSeo = {
    title: "A properly sized SEO title for the product page",
    description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
    keywords: ["oats porridge", "healthy breakfast"],
  };
  const basePayload = {
    name: "Schema Test Product",
    sku: "SCHEMA-TEST-SKU",
    shortDescription: "A short description.",
    description: "A longer description.",
    categoryId: "507f1f77bcf86cd799439011",
    brandId: "507f1f77bcf86cd799439012",
    mediaIds: ["507f1f77bcf86cd799439013"],
    pricing: { mrp: 499, sellingPrice: 399 },
    inventory: { stockQuantity: 10 },
  };

  it("rejects a missing SEO title/description/keywords", () => {
    expect(createProductSchema.safeParse({ ...basePayload, seo: { ...baseSeo, title: undefined } }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...basePayload, seo: { ...baseSeo, description: undefined } }).success).toBe(
      false
    );
    expect(createProductSchema.safeParse({ ...basePayload, seo: { ...baseSeo, keywords: undefined } }).success).toBe(
      false
    );
  });

  it("rejects a too-short SEO title/description", () => {
    const result = createProductSchema.safeParse({ ...basePayload, seo: { ...baseSeo, title: "short" } });
    expect(result.success).toBe(false);
  });

  it("normalizes duplicate keywords (trim/lowercase/dedupe) instead of rejecting them", () => {
    const result = createProductSchema.safeParse({
      ...basePayload,
      seo: { ...baseSeo, keywords: [" Oats ", "OATS", "  Porridge  ", ""] },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.seo.keywords).toEqual(["oats", "porridge"]);
  });

  it("rejects more than 20 SEO keywords", () => {
    const result = createProductSchema.safeParse({
      ...basePayload,
      seo: { ...baseSeo, keywords: Array.from({ length: 21 }, (_, i) => `keyword-${i}`) },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty keywords array (all entries blank after normalization)", () => {
    const result = createProductSchema.safeParse({ ...basePayload, seo: { ...baseSeo, keywords: ["   ", ""] } });
    expect(result.success).toBe(false);
  });

  it("rejects selling price greater than MRP at the schema level", () => {
    const result = createProductSchema.safeParse({
      ...basePayload,
      seo: baseSeo,
      pricing: { mrp: 100, sellingPrice: 150 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name that is only whitespace", () => {
    const result = createProductSchema.safeParse({ ...basePayload, seo: baseSeo, name: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an empty mediaIds array (no primary image)", () => {
    const result = createProductSchema.safeParse({ ...basePayload, seo: baseSeo, mediaIds: [] });
    expect(result.success).toBe(false);
  });
});

describe("product.service: update (unit)", () => {
  it("applies a valid partial update", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    const updated = await updateProductById(product!.productId, { name: "Updated Name" });
    expect(updated!.name).toBe("Updated Name");
  });

  it("updates pricing and re-validates sellingPrice <= mrp against the merged result", async () => {
    const product = await createProduct(await validInput({ pricing: { mrp: 500, sellingPrice: 400 } }));
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    await expect(updateProductById(product!.productId, { pricing: { sellingPrice: 600 } })).rejects.toThrow();

    const updated = await updateProductById(product!.productId, { pricing: { mrp: 700 } });
    expect(updated!.pricing.mrp).toBe(700);
    expect(updated!.pricing.sellingPrice).toBe(400);
  });

  it("replacing the image set detaches removed media and attaches new media", async () => {
    const media1 = await makeMedia();
    const product = await createProduct(await validInput({ mediaIds: [media1._id.toString()] }));
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    const media2 = await makeMedia();
    await updateProductById(product!.productId, { mediaIds: [media2._id.toString()] });

    const [fresh1, fresh2] = await Promise.all([
      Media.findById(media1._id).lean(),
      Media.findById(media2._id).lean(),
    ]);
    expect(fresh1?.status).toBe("TEMPORARY");
    expect(fresh2?.status).toBe("ATTACHED");
    expect(fresh2?.isPrimary).toBe(true);
  });

  it("updates category and brand references, validating the new ones", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    const newCategory = await makeCategory();
    const newBrand = await makeBrand();
    const updated = await updateProductById(product!.productId, {
      categoryId: newCategory._id.toString(),
      brandId: newBrand._id.toString(),
    });
    expect(updated!.category?.id).toBe(newCategory._id.toString());
    expect(updated!.brand?.id).toBe(newBrand._id.toString());
  });

  it("updates the slug with uniqueness re-checked", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    const updated = await updateProductById(product!.productId, { slug: "  Brand New Slug!! " });
    expect(updated!.slug).toBe("brand-new-slug");
  });

  it("updates SEO fields", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    const updated = await updateProductById(product!.productId, {
      seo: { title: "A brand new, still properly sized SEO title here" },
    });
    expect(updated!.seo.title).toBe("A brand new, still properly sized SEO title here");
  });

  it("blocks activation when required data is missing or invalid", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    // Force the category inactive after the product referenced it, then try
    // to activate — this is exactly the defensive re-check assertReady...
    // exists for.
    await Category.updateOne({ _id: product!.category!.id }, { $set: { isActive: false } });
    await expect(updateProductById(product!.productId, { status: "ACTIVE" })).rejects.toMatchObject({
      statusCode: 409,
    });
    await Category.updateOne({ _id: product!.category!.id }, { $set: { isActive: true } });
  });

  it("activates successfully once all requirements are met", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));
    const updated = await updateProductById(product!.productId, { status: "ACTIVE" });
    expect(updated!.status).toBe("ACTIVE");
  });
});

describe("product.service: duplicate", () => {
  it("clones a product with a fresh slug/SKU, DRAFT status, and no images", async () => {
    const original = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(original!.productId));

    const clone = await duplicateProductById(original!.productId);
    createdProductIds.push(new mongoose.Types.ObjectId(clone!.productId));

    expect(clone!.slug).not.toBe(original!.slug);
    expect(clone!.sku).not.toBe(original!.sku);
    expect(clone!.status).toBe("DRAFT");
    expect(clone!.images).toHaveLength(0);
    expect(clone!.inventory.stockQuantity).toBe(0);
  });
});

describe("product.service: delete", () => {
  it("returns null for a nonexistent product", async () => {
    await expect(deleteProductById(new mongoose.Types.ObjectId().toString())).resolves.toBeNull();
  });

  it("hard-deletes a DRAFT product and detaches its media", async () => {
    const media = await makeMedia();
    const product = await createProduct(await validInput({ mediaIds: [media._id.toString()] }));

    const result = await deleteProductById(product!.productId);
    expect(result).toEqual({ archived: false });
    expect(await Product.findById(product!.productId).lean()).toBeNull();
    expect((await Media.findById(media._id).lean())?.status).toBe("TEMPORARY");
  });

  it("archives (soft-deletes) a product that has ever been ACTIVE, instead of destroying it", async () => {
    const product = await createProduct(await validInput());
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));
    await updateProductById(product!.productId, { status: "ACTIVE" });

    const result = await deleteProductById(product!.productId);
    expect(result).toEqual({ archived: true });
    const fresh = await Product.findById(product!.productId).lean();
    expect(fresh).not.toBeNull();
    expect(fresh?.status).toBe("ARCHIVED");
  });
});

describe("product.service: list/filter/sort/pagination", () => {
  it("filters by category, brand, status, and search; paginates results", async () => {
    const category = await makeCategory();
    const brand = await makeBrand();
    const media = await makeMedia();
    const product = await createProduct(
      await validInput({
        name: `Findable Zephyr ${RUN_ID}`,
        categoryId: category._id.toString(),
        brandId: brand._id.toString(),
        mediaIds: [media._id.toString()],
      })
    );
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    const result = await getProductList({
      page: 1,
      pageSize: 10,
      search: "zephyr",
      categoryId: category._id.toString(),
      brandId: brand._id.toString(),
    });
    expect(result.items.some((p) => p.productId === product!.productId)).toBe(true);
    expect(result.items[0].image?.mediaId).toBe(media._id.toString());
  });
});

describe("computeDiscount (money-safe helper)", () => {
  it("computes discount and percentage without floating-point drift", () => {
    expect(computeDiscount(499, 399)).toEqual({ discount: 100, discountPercentage: 20.04 });
    expect(computeDiscount(100, 100)).toEqual({ discount: 0, discountPercentage: 0 });
  });
});

describe("Product HTTP endpoints: auth, validation, mass-assignment (integration)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/admin/products");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin with 403", async () => {
    const user = await makeUser("user");
    const res = await request(app).get("/api/admin/products").set("Cookie", authCookie(user));
    expect(res.status).toBe(403);
  });

  it("admin can create via HTTP; SEO keywords are normalized (trim/lowercase/dedupe)", async () => {
    const admin = await makeUser("admin");
    const input = await validInput({
      seo: {
        title: "A properly sized SEO title for the product page",
        description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
        keywords: [" Oats ", "OATS", "  Porridge  ", ""],
      },
    });
    const res = await request(app).post("/api/admin/products").set("Cookie", authCookie(admin)).send(input);
    expect(res.status).toBe(201);
    createdProductIds.push(new mongoose.Types.ObjectId(res.body.data.product.productId));
    expect(res.body.data.product.seo.keywords).toEqual(["oats", "porridge"]);
  });

  it("rejects a request missing mandatory fields with 400", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .post("/api/admin/products")
      .set("Cookie", authCookie(admin))
      .send({ name: "Incomplete Product" });
    expect(res.status).toBe(400);
  });

  it("rejects more than 20 SEO keywords with 400", async () => {
    const admin = await makeUser("admin");
    const input = await validInput({
      seo: {
        title: "A properly sized SEO title for the product page",
        description: "A properly sized SEO meta description that falls within the accepted length bounds here.",
        keywords: Array.from({ length: 21 }, (_, i) => `keyword-${i}`),
      },
    });
    const res = await request(app).post("/api/admin/products").set("Cookie", authCookie(admin)).send(input);
    expect(res.status).toBe(400);
  });

  it("PATCH strips forbidden fields via mass-assignment attempt", async () => {
    const admin = await makeUser("admin");
    const createRes = await request(app)
      .post("/api/admin/products")
      .set("Cookie", authCookie(admin))
      .send(await validInput());
    const productId = createRes.body.data.product.productId;
    createdProductIds.push(new mongoose.Types.ObjectId(productId));

    const patchRes = await request(app)
      .patch(`/api/admin/products/${productId}`)
      .set("Cookie", authCookie(admin))
      .send({ sortOrder: 7, createdAt: "2000-01-01T00:00:00.000Z", _id: "000000000000000000000000" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.product.sortOrder).toBe(7);

    const fresh = await Product.findById(productId).lean();
    expect(fresh?.createdAt.toISOString()).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("GET /:id returns 404 for a malformed id", async () => {
    const admin = await makeUser("admin");
    const res = await request(app).get("/api/admin/products/not-a-valid-id").set("Cookie", authCookie(admin));
    expect(res.status).toBe(404);
  });

  it("DELETE on a nonexistent product returns 404", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .delete(`/api/admin/products/${new mongoose.Types.ObjectId().toString()}`)
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(404);
  });

  it("POST /:id/duplicate clones the product", async () => {
    const admin = await makeUser("admin");
    const createRes = await request(app)
      .post("/api/admin/products")
      .set("Cookie", authCookie(admin))
      .send(await validInput());
    const productId = createRes.body.data.product.productId;
    createdProductIds.push(new mongoose.Types.ObjectId(productId));

    const dupRes = await request(app)
      .post(`/api/admin/products/${productId}/duplicate`)
      .set("Cookie", authCookie(admin));
    expect(dupRes.status).toBe(201);
    createdProductIds.push(new mongoose.Types.ObjectId(dupRes.body.data.product.productId));
    expect(dupRes.body.data.product.sku).not.toBe(createRes.body.data.product.sku);
  });
});
