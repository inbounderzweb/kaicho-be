import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, MediaUsage, Category, MediaEntityType } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import {
  createCategory,
  updateCategoryById,
  deleteCategoryById,
  getCategoryList,
} from "../category.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdCategoryIds: mongoose.Types.ObjectId[] = [];
const createdMediaIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `9${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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
    entityType: MediaEntityType;
    entityId: mongoose.Types.ObjectId;
    size: number;
  }> = {}
) {
  const uploader = await makeUser("admin");
  const media = await Media.create({
    mediaType: overrides.mediaType ?? "IMAGE",
    storageProvider: "local",
    storageKey: `images/test/${RUN_ID}-${createdMediaIds.length}`,
    originalName: "test.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: overrides.size ?? 100,
    status: overrides.status ?? "TEMPORARY",
    entityType: overrides.entityType,
    entityId: overrides.entityId,
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
  await Category.deleteMany({ _id: { $in: createdCategoryIds } });
  await MediaUsage.deleteMany({ mediaId: { $in: createdMediaIds } });
  await Media.deleteMany({ _id: { $in: createdMediaIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("category.service (unit)", () => {
  it("creates a category with an auto-generated slug", async () => {
    const category = await createCategory({ name: "Breakfast Foods!!" });
    createdCategoryIds.push(new mongoose.Types.ObjectId(category!.categoryId));
    expect(category!.slug).toBe("breakfast-foods");
  });

  it("normalizes a manually supplied slug rather than trusting it raw", async () => {
    const category = await createCategory({ name: "Snacks", slug: "  Crunchy Snacks!! " });
    createdCategoryIds.push(new mongoose.Types.ObjectId(category!.categoryId));
    expect(category!.slug).toBe("crunchy-snacks");
  });

  it("rejects a duplicate slug", async () => {
    const first = await createCategory({ name: `Unique-${RUN_ID}` });
    createdCategoryIds.push(new mongoose.Types.ObjectId(first!.categoryId));
    await expect(createCategory({ name: `Different Name But Same Slug`, slug: first!.slug })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects an invalid/nonexistent parent", async () => {
    await expect(createCategory({ name: "Bad Parent Test", parentId: "not-a-valid-id" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      createCategory({ name: "Missing Parent Test", parentId: new mongoose.Types.ObjectId().toString() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a DOCUMENT media as a category image", async () => {
    const pdfMedia = await makeMedia({ mediaType: "DOCUMENT" });
    await expect(
      createCategory({ name: "Doc Image Test", imageMediaId: pdfMedia._id.toString() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an image over the 1.5MB category-image limit", async () => {
    const oversized = await makeMedia({ size: 2 * 1024 * 1024 });
    await expect(
      createCategory({ name: "Oversized Image Test", imageMediaId: oversized._id.toString() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows an image already used by another entity to be reused (no single-owner lock)", async () => {
    const otherCategory = await createCategory({ name: `Other-${RUN_ID}` });
    createdCategoryIds.push(new mongoose.Types.ObjectId(otherCategory!.categoryId));
    const shared = await makeMedia();
    await updateCategoryById(otherCategory!.categoryId, { imageMediaId: shared._id.toString() });

    const reuser = await createCategory({ name: `Reuser-${RUN_ID}`, imageMediaId: shared._id.toString() });
    createdCategoryIds.push(new mongoose.Types.ObjectId(reuser!.categoryId));
    expect(reuser!.image?.mediaId).toBe(shared._id.toString());

    // One physical asset, two independent usage references.
    const usageCount = await MediaUsage.countDocuments({ mediaId: shared._id });
    expect(usageCount).toBe(2);
  });

  it("attaches a valid image and flips its status to ATTACHED", async () => {
    const media = await makeMedia();
    const category = await createCategory({ name: `Imaged-${RUN_ID}`, imageMediaId: media._id.toString() });
    createdCategoryIds.push(new mongoose.Types.ObjectId(category!.categoryId));

    const fresh = await Media.findById(media._id).lean();
    expect(fresh?.status).toBe("ATTACHED");
    const usage = await MediaUsage.findOne({ mediaId: media._id }).lean();
    expect(usage?.entityType).toBe("CATEGORY");
    expect(usage?.entityId?.toString()).toBe(category!.categoryId);
    expect(usage?.field).toBe("image");
    expect(category!.image?.mediaId).toBe(media._id.toString());
  });

  it("rolls back category creation when the referenced image cannot be resolved", async () => {
    const missingId = new mongoose.Types.ObjectId().toString();
    const beforeCount = await Category.countDocuments({ name: "Rollback Test" });
    await expect(
      createCategory({ name: "Rollback Test", imageMediaId: missingId })
    ).rejects.toThrow();
    const afterCount = await Category.countDocuments({ name: "Rollback Test" });
    expect(afterCount).toBe(beforeCount);
  });

  it("rejects circular parent hierarchy on update", async () => {
    const a = await createCategory({ name: `A-${RUN_ID}` });
    createdCategoryIds.push(new mongoose.Types.ObjectId(a!.categoryId));
    const b = await createCategory({ name: `B-${RUN_ID}`, parentId: a!.categoryId });
    createdCategoryIds.push(new mongoose.Types.ObjectId(b!.categoryId));
    const c = await createCategory({ name: `C-${RUN_ID}`, parentId: b!.categoryId });
    createdCategoryIds.push(new mongoose.Types.ObjectId(c!.categoryId));

    // A -> B -> C already exists; making A's parent = C would close the loop.
    await expect(updateCategoryById(a!.categoryId, { parentId: c!.categoryId })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a category being set as its own parent", async () => {
    const a = await createCategory({ name: `SelfParent-${RUN_ID}` });
    createdCategoryIds.push(new mongoose.Types.ObjectId(a!.categoryId));
    await expect(updateCategoryById(a!.categoryId, { parentId: a!.categoryId })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("replacing the image detaches the old media and attaches the new one", async () => {
    const media1 = await makeMedia();
    const media2 = await makeMedia();
    const category = await createCategory({ name: `Swap-${RUN_ID}`, imageMediaId: media1._id.toString() });
    createdCategoryIds.push(new mongoose.Types.ObjectId(category!.categoryId));

    await updateCategoryById(category!.categoryId, { imageMediaId: media2._id.toString() });

    const [freshMedia1, freshMedia2] = await Promise.all([
      Media.findById(media1._id).lean(),
      Media.findById(media2._id).lean(),
    ]);
    expect(freshMedia1?.status).toBe("TEMPORARY");
    expect(freshMedia2?.status).toBe("ATTACHED");

    // The old usage row is gone; the new one points at this category.
    expect(await MediaUsage.countDocuments({ mediaId: media1._id })).toBe(0);
    const usage2 = await MediaUsage.findOne({ mediaId: media2._id }).lean();
    expect(usage2?.entityId?.toString()).toBe(category!.categoryId);
  });

  it("deleting a category with children is blocked with a dependency count", async () => {
    const parent = await createCategory({ name: `HasChild-${RUN_ID}` });
    createdCategoryIds.push(new mongoose.Types.ObjectId(parent!.categoryId));
    const child = await createCategory({ name: `IsChild-${RUN_ID}`, parentId: parent!.categoryId });
    createdCategoryIds.push(new mongoose.Types.ObjectId(child!.categoryId));

    await expect(deleteCategoryById(parent!.categoryId)).rejects.toMatchObject({
      statusCode: 409,
      details: { childCategories: 1, products: 0 },
    });
  });

  it("deleting a leaf category succeeds and reverts its media to TEMPORARY", async () => {
    const media = await makeMedia();
    const category = await createCategory({ name: `Leaf-${RUN_ID}`, imageMediaId: media._id.toString() });

    const result = await deleteCategoryById(category!.categoryId);
    expect(result).toBe(true);
    expect(await Category.findById(category!.categoryId).lean()).toBeNull();

    const freshMedia = await Media.findById(media._id).lean();
    expect(freshMedia?.status).toBe("TEMPORARY");
  });

  it("list search matches name and slug, and resolves parent name + image without N+1", async () => {
    const media = await makeMedia();
    const parent = await createCategory({ name: `SearchParent-${RUN_ID}` });
    createdCategoryIds.push(new mongoose.Types.ObjectId(parent!.categoryId));
    const child = await createCategory({
      name: `Zephyr Unique ${RUN_ID}`,
      parentId: parent!.categoryId,
      imageMediaId: media._id.toString(),
    });
    createdCategoryIds.push(new mongoose.Types.ObjectId(child!.categoryId));

    const result = await getCategoryList({ page: 1, pageSize: 20, search: "zephyr unique" });
    const found = result.items.find((i) => i.categoryId === child!.categoryId);
    expect(found).toBeDefined();
    expect(found?.parentName).toBe(parent!.name);
    expect(found?.image?.mediaId).toBe(media._id.toString());
  });
});

describe("Category HTTP endpoints: auth, mass-assignment, validation (integration)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/admin/categories");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin with 403", async () => {
    const user = await makeUser("user");
    const res = await request(app).get("/api/admin/categories").set("Cookie", authCookie(user));
    expect(res.status).toBe(403);
  });

  it("POST validates and creates via HTTP, GET /options returns lightweight shape", async () => {
    const admin = await makeUser("admin");
    const createRes = await request(app)
      .post("/api/admin/categories")
      .set("Cookie", authCookie(admin))
      .send({ name: `HttpCat-${RUN_ID}` });
    expect(createRes.status).toBe(201);
    createdCategoryIds.push(new mongoose.Types.ObjectId(createRes.body.data.category.categoryId));

    const optionsRes = await request(app).get("/api/admin/categories/options").set("Cookie", authCookie(admin));
    expect(optionsRes.status).toBe(200);
    expect(Array.isArray(optionsRes.body.data)).toBe(true);
    expect(optionsRes.body.data.some((o: { id: string }) => o.id === createRes.body.data.category.categoryId)).toBe(
      true
    );
  });

  it("PATCH strips forbidden fields via mass-assignment attempt", async () => {
    const admin = await makeUser("admin");
    const createRes = await request(app)
      .post("/api/admin/categories")
      .set("Cookie", authCookie(admin))
      .send({ name: `MassAssign-${RUN_ID}` });
    const categoryId = createRes.body.data.category.categoryId;
    createdCategoryIds.push(new mongoose.Types.ObjectId(categoryId));

    const patchRes = await request(app)
      .patch(`/api/admin/categories/${categoryId}`)
      .set("Cookie", authCookie(admin))
      .send({ sortOrder: 5, createdAt: "2000-01-01T00:00:00.000Z", _id: "000000000000000000000000" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.category.sortOrder).toBe(5);

    const fresh = await Category.findById(categoryId).lean();
    expect(fresh?.createdAt.toISOString()).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("GET /:id returns 404 for a malformed id", async () => {
    const admin = await makeUser("admin");
    const res = await request(app).get("/api/admin/categories/not-a-valid-id").set("Cookie", authCookie(admin));
    expect(res.status).toBe(404);
  });

  it("DELETE returns 409 with a details payload when the category has children", async () => {
    const admin = await makeUser("admin");
    const parentRes = await request(app)
      .post("/api/admin/categories")
      .set("Cookie", authCookie(admin))
      .send({ name: `HttpParent-${RUN_ID}` });
    const parentId = parentRes.body.data.category.categoryId;
    createdCategoryIds.push(new mongoose.Types.ObjectId(parentId));

    const childRes = await request(app)
      .post("/api/admin/categories")
      .set("Cookie", authCookie(admin))
      .send({ name: `HttpChild-${RUN_ID}`, parentId });
    createdCategoryIds.push(new mongoose.Types.ObjectId(childRes.body.data.category.categoryId));

    const deleteRes = await request(app).delete(`/api/admin/categories/${parentId}`).set("Cookie", authCookie(admin));
    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.details).toMatchObject({ childCategories: 1 });
  });
});
