import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, MediaUsage, Brand, Product, Category } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { createBrand, updateBrandById, deleteBrandById } from "../brand.service";
import { createProduct } from "../../product/product.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdBrandIds: mongoose.Types.ObjectId[] = [];
const createdMediaIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];
const createdCategoryIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `8${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

async function makeMedia(
  overrides: Partial<{
    mediaType: "IMAGE" | "DOCUMENT";
    status: "TEMPORARY" | "ATTACHED";
    size: number;
  }> = {}
) {
  const uploader = await makeUser("admin");
  const media = await Media.create({
    mediaType: overrides.mediaType ?? "IMAGE",
    storageProvider: "local",
    storageKey: `images/brand-test/${RUN_ID}-${createdMediaIds.length}`,
    originalName: "logo.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: overrides.size ?? 100,
    status: overrides.status ?? "TEMPORARY",
    uploadedBy: uploader._id,
  });
  createdMediaIds.push(media._id);
  return media;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await Category.deleteMany({ _id: { $in: createdCategoryIds } });
  await Brand.deleteMany({ _id: { $in: createdBrandIds } });
  await MediaUsage.deleteMany({ mediaId: { $in: createdMediaIds } });
  await Media.deleteMany({ _id: { $in: createdMediaIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("brand.service (unit)", () => {
  it("creates a brand with an auto-generated slug", async () => {
    const brand = await createBrand({ name: "Kaicho Foods!!" });
    createdBrandIds.push(new mongoose.Types.ObjectId(brand!.brandId));
    expect(brand!.slug).toBe("kaicho-foods");
  });

  it("rejects a duplicate slug", async () => {
    const first = await createBrand({ name: `Unique-${RUN_ID}` });
    createdBrandIds.push(new mongoose.Types.ObjectId(first!.brandId));
    await expect(createBrand({ name: "Different Name Same Slug", slug: first!.slug })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects a DOCUMENT media as a brand logo", async () => {
    const pdfMedia = await makeMedia({ mediaType: "DOCUMENT" });
    await expect(
      createBrand({ name: "Doc Logo Test", logoMediaId: pdfMedia._id.toString() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an oversized logo", async () => {
    const oversized = await makeMedia({ size: 2 * 1024 * 1024 });
    await expect(
      createBrand({ name: "Oversized Logo Test", logoMediaId: oversized._id.toString() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("attaches a valid logo and flips its status to ATTACHED", async () => {
    const media = await makeMedia();
    const brand = await createBrand({ name: `Logo-${RUN_ID}`, logoMediaId: media._id.toString() });
    createdBrandIds.push(new mongoose.Types.ObjectId(brand!.brandId));

    const fresh = await Media.findById(media._id).lean();
    expect(fresh?.status).toBe("ATTACHED");
    // The entity pointer now lives on a MediaUsage row, not the Media doc.
    const usage = await MediaUsage.findOne({ mediaId: media._id }).lean();
    expect(usage?.entityType).toBe("BRAND");
    expect(usage?.entityId?.toString()).toBe(brand!.brandId);
    expect(usage?.field).toBe("logo");
    expect(brand!.logo?.mediaId).toBe(media._id.toString());
  });

  it("replacing the logo detaches the old media and attaches the new one", async () => {
    const media1 = await makeMedia();
    const media2 = await makeMedia();
    const brand = await createBrand({ name: `Swap-${RUN_ID}`, logoMediaId: media1._id.toString() });
    createdBrandIds.push(new mongoose.Types.ObjectId(brand!.brandId));

    await updateBrandById(brand!.brandId, { logoMediaId: media2._id.toString() });

    const [freshMedia1, freshMedia2] = await Promise.all([
      Media.findById(media1._id).lean(),
      Media.findById(media2._id).lean(),
    ]);
    expect(freshMedia1?.status).toBe("TEMPORARY");
    expect(freshMedia2?.status).toBe("ATTACHED");
  });

  it("blocks deletion when products reference the brand", async () => {
    const brand = await createBrand({ name: `Referenced-${RUN_ID}` });
    createdBrandIds.push(new mongoose.Types.ObjectId(brand!.brandId));
    const category = await Category.create({ name: `BrandTestCat-${RUN_ID}`, slug: `brand-test-cat-${RUN_ID}` });
    createdCategoryIds.push(category._id);
    const media = await makeMedia();
    const product = await createProduct({
      name: `RefProduct-${RUN_ID}`,
      sku: `REF-${RUN_ID}`,
      shortDescription: "x",
      description: "x",
      categoryId: category._id.toString(),
      brandId: brand!.brandId,
      mediaIds: [media._id.toString()],
      pricing: { mrp: 100, sellingPrice: 90 },
      inventory: { stockQuantity: 5 },
      seo: {
        title: "Reference product SEO title here",
        description: "A sufficiently long SEO description for validation purposes here.",
        keywords: ["ref"],
      },
    });
    createdProductIds.push(new mongoose.Types.ObjectId(product!.productId));

    await expect(deleteBrandById(brand!.brandId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("deleting an unreferenced brand succeeds and reverts its logo to TEMPORARY", async () => {
    const media = await makeMedia();
    const brand = await createBrand({ name: `Leaf-${RUN_ID}`, logoMediaId: media._id.toString() });

    const result = await deleteBrandById(brand!.brandId);
    expect(result).toBe(true);
    expect(await Brand.findById(brand!.brandId).lean()).toBeNull();
    const freshMedia = await Media.findById(media._id).lean();
    expect(freshMedia?.status).toBe("TEMPORARY");
  });
});

describe("Brand HTTP endpoints: auth, mass-assignment (integration)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/admin/brands");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin with 403", async () => {
    const user = await makeUser("user");
    const res = await request(app).get("/api/admin/brands").set("Cookie", authCookie(user));
    expect(res.status).toBe(403);
  });

  it("POST validates and creates via HTTP, GET /options returns lightweight shape", async () => {
    const admin = await makeUser("admin");
    const createRes = await request(app)
      .post("/api/admin/brands")
      .set("Cookie", authCookie(admin))
      .send({ name: `HttpBrand-${RUN_ID}` });
    expect(createRes.status).toBe(201);
    createdBrandIds.push(new mongoose.Types.ObjectId(createRes.body.data.brand.brandId));

    const optionsRes = await request(app).get("/api/admin/brands/options").set("Cookie", authCookie(admin));
    expect(optionsRes.status).toBe(200);
    expect(optionsRes.body.data.some((o: { id: string }) => o.id === createRes.body.data.brand.brandId)).toBe(true);
  });

  it("PATCH strips forbidden fields via mass-assignment attempt", async () => {
    const admin = await makeUser("admin");
    const createRes = await request(app)
      .post("/api/admin/brands")
      .set("Cookie", authCookie(admin))
      .send({ name: `MassAssign-${RUN_ID}` });
    const brandId = createRes.body.data.brand.brandId;
    createdBrandIds.push(new mongoose.Types.ObjectId(brandId));

    const patchRes = await request(app)
      .patch(`/api/admin/brands/${brandId}`)
      .set("Cookie", authCookie(admin))
      .send({ sortOrder: 5, createdAt: "2000-01-01T00:00:00.000Z" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.brand.sortOrder).toBe(5);

    const fresh = await Brand.findById(brandId).lean();
    expect(fresh?.createdAt.toISOString()).not.toBe("2000-01-01T00:00:00.000Z");
  });
});
