import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Blog, BlogCategory } from "../../database/models";
import { slugify } from "../../common/utils/slugify";
import { assertImageMedia, resolveBlogImage, resolveBlogImages, syncEntityMedia } from "./blog.media";
import type { CreateBlogCategoryInput, UpdateBlogCategoryInput } from "./blogCategory.validation";

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function shapeCategory(doc: any, opts: { blogCount?: number; image?: any } = {}) {
  return {
    categoryId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description ?? null,
    image: opts.image !== undefined ? opts.image : await resolveBlogImage(doc.imageMediaId),
    metaTitle: doc.metaTitle ?? null,
    metaDescription: doc.metaDescription ?? null,
    status: doc.status,
    blogCount: opts.blogCount ?? 0,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function listBlogCategoriesAdmin(params: { search?: unknown; status?: unknown }) {
  const filter: Record<string, unknown> = {};
  if (typeof params.search === "string" && params.search.trim()) {
    filter.name = new RegExp(escapeRegex(params.search.trim()), "i");
  }
  if (params.status === "ACTIVE" || params.status === "INACTIVE") filter.status = params.status;

  const docs = await BlogCategory.find(filter).sort({ name: 1 }).lean();
  const counts = await Blog.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { categoryId: { $in: docs.map((d) => d._id) } } },
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));
  const imageMap = await resolveBlogImages(docs.map((d) => d.imageMediaId));

  return Promise.all(
    docs.map((doc) =>
      shapeCategory(doc, {
        blogCount: countMap.get(doc._id.toString()) ?? 0,
        image: doc.imageMediaId ? imageMap.get(doc.imageMediaId.toString()) ?? null : null,
      })
    )
  );
}

/** Slim list for the blog editor's category <select>. */
export async function listBlogCategoryOptions() {
  const docs = await BlogCategory.find({ status: "ACTIVE" }).select("name slug").sort({ name: 1 }).lean();
  return docs.map((d) => ({ id: d._id.toString(), name: d.name, slug: d.slug }));
}

export async function getBlogCategoryById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await BlogCategory.findById(id).lean();
  if (!doc) return null;
  const blogCount = await Blog.countDocuments({ categoryId: doc._id });
  return shapeCategory(doc, { blogCount });
}

async function ensureUniqueSlug(slug: string, excludeId?: string): Promise<void> {
  const clash = await BlogCategory.findOne({
    slug,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).lean();
  if (clash) throw new AppError("A blog category with this slug already exists", 409);
}

export async function createBlogCategory(input: CreateBlogCategoryInput) {
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new AppError("Could not derive a valid slug", 400);
  await ensureUniqueSlug(slug);
  if (await BlogCategory.exists({ name: input.name.trim() })) {
    throw new AppError("A blog category with this name already exists", 409);
  }
  if (input.imageMediaId) await assertImageMedia(input.imageMediaId);

  const doc = await BlogCategory.create({
    name: input.name.trim(),
    slug,
    description: input.description?.trim() || undefined,
    imageMediaId: input.imageMediaId || undefined,
    metaTitle: input.metaTitle?.trim() || undefined,
    metaDescription: input.metaDescription?.trim() || undefined,
    status: input.status ?? "ACTIVE",
  });

  if (input.imageMediaId) {
    await syncEntityMedia({
      entityType: "BLOG_CATEGORY",
      entityId: doc._id.toString(),
      nextIds: [input.imageMediaId],
      prevIds: [],
    });
  }
  return getBlogCategoryById(doc._id.toString());
}

export async function updateBlogCategory(id: string, patch: UpdateBlogCategoryInput) {
  if (!isValidObjectId(id)) return null;
  const doc = await BlogCategory.findById(id).exec();
  if (!doc) return null;

  if (patch.name !== undefined) {
    const clash = await BlogCategory.findOne({ name: patch.name.trim(), _id: { $ne: id } }).lean();
    if (clash) throw new AppError("A blog category with this name already exists", 409);
    doc.name = patch.name.trim();
  }
  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug || doc.name);
    if (!slug) throw new AppError("Invalid slug", 400);
    await ensureUniqueSlug(slug, id);
    doc.slug = slug;
  }
  if (patch.description !== undefined) doc.description = patch.description?.trim() || undefined;
  if (patch.metaTitle !== undefined) doc.metaTitle = patch.metaTitle?.trim() || undefined;
  if (patch.metaDescription !== undefined) doc.metaDescription = patch.metaDescription?.trim() || undefined;
  if (patch.status !== undefined) doc.status = patch.status;

  const prevImageId = doc.imageMediaId?.toString();
  if (patch.imageMediaId !== undefined) {
    if (patch.imageMediaId) {
      await assertImageMedia(patch.imageMediaId);
      doc.imageMediaId = new mongoose.Types.ObjectId(patch.imageMediaId);
    } else {
      doc.imageMediaId = undefined;
    }
  }

  await doc.save();

  if (patch.imageMediaId !== undefined) {
    await syncEntityMedia({
      entityType: "BLOG_CATEGORY",
      entityId: id,
      nextIds: doc.imageMediaId ? [doc.imageMediaId.toString()] : [],
      prevIds: prevImageId ? [prevImageId] : [],
    });
  }
  return getBlogCategoryById(id);
}

export async function deleteBlogCategory(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await BlogCategory.findById(id).exec();
  if (!doc) return null;

  const inUse = await Blog.countDocuments({ categoryId: doc._id });
  if (inUse > 0) {
    throw new AppError(
      `This category is used by ${inUse} blog post${inUse === 1 ? "" : "s"}. Reassign them first.`,
      409
    );
  }
  if (doc.imageMediaId) {
    await syncEntityMedia({
      entityType: "BLOG_CATEGORY",
      entityId: id,
      nextIds: [],
      prevIds: [doc.imageMediaId.toString()],
    });
  }
  await doc.deleteOne();
  return true;
}

// ---- Public ----

export async function listBlogCategoriesPublic() {
  const docs = await BlogCategory.find({ status: "ACTIVE" }).sort({ name: 1 }).lean();
  const withCounts = await Blog.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { categoryId: { $in: docs.map((d) => d._id) }, status: "PUBLISHED" } },
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(withCounts.map((c) => [c._id.toString(), c.count]));
  const imageMap = await resolveBlogImages(docs.map((d) => d.imageMediaId));

  return docs.map((doc) => ({
    categoryId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description ?? null,
    image: doc.imageMediaId ? imageMap.get(doc.imageMediaId.toString()) ?? null : null,
    postCount: countMap.get(doc._id.toString()) ?? 0,
  }));
}

export async function getBlogCategoryBySlugPublic(slug: string) {
  const doc = await BlogCategory.findOne({ slug: slug.toLowerCase(), status: "ACTIVE" }).lean();
  if (!doc) return null;
  return {
    categoryId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description ?? null,
    image: await resolveBlogImage(doc.imageMediaId),
    metaTitle: doc.metaTitle ?? null,
    metaDescription: doc.metaDescription ?? null,
  };
}
