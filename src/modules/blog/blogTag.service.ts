import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Blog, BlogTag } from "../../database/models";
import { slugify } from "../../common/utils/slugify";

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function shapeTag(doc: any) {
  return {
    tagId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a list of free-text tag names to BlogTag ids, creating any that
 * don't exist yet (deduped by slug). This is what the blog editor calls
 * indirectly on every save — hence the upsert rather than a hard "unknown
 * tag" error. Returns ids in the same order as the input, duplicates removed.
 */
export async function resolveTagIds(names: string[] | undefined): Promise<mongoose.Types.ObjectId[]> {
  if (!names || names.length === 0) return [];

  const bySlug = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const slug = slugify(name);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, name);
  }
  if (bySlug.size === 0) return [];

  const slugs = [...bySlug.keys()];
  const existing = await BlogTag.find({ slug: { $in: slugs } }).exec();
  const existingBySlug = new Map(existing.map((t) => [t.slug, t._id]));

  const missing = slugs.filter((s) => !existingBySlug.has(s));
  if (missing.length) {
    const created = await BlogTag.insertMany(
      missing.map((slug) => ({ slug, name: bySlug.get(slug)! })),
      { ordered: false }
    ).catch(async () => {
      // A concurrent save may have created the same tag between our read and
      // this write — fall back to re-reading rather than failing the request.
      return BlogTag.find({ slug: { $in: missing } }).exec();
    });
    for (const t of created as any[]) existingBySlug.set(t.slug, t._id);
  }

  return slugs.map((s) => existingBySlug.get(s)).filter(Boolean) as mongoose.Types.ObjectId[];
}

export async function listBlogTags(search?: unknown) {
  const filter: Record<string, unknown> = {};
  if (typeof search === "string" && search.trim()) {
    filter.name = new RegExp(escapeRegex(search.trim()), "i");
  }
  const docs = await BlogTag.find(filter).sort({ name: 1 }).limit(200).lean();
  return docs.map(shapeTag);
}

export async function createBlogTag(name: string) {
  const slug = slugify(name);
  if (!slug) throw new AppError("Could not derive a valid slug from that name", 400);
  if (await BlogTag.exists({ slug })) throw new AppError("A tag with this name already exists", 409);
  const doc = await BlogTag.create({ name: name.trim(), slug });
  return shapeTag(doc.toObject());
}

export async function updateBlogTag(id: string, name: string) {
  if (!isValidObjectId(id)) return null;
  const slug = slugify(name);
  if (!slug) throw new AppError("Could not derive a valid slug from that name", 400);
  const clash = await BlogTag.findOne({ slug, _id: { $ne: id } }).lean();
  if (clash) throw new AppError("A tag with this name already exists", 409);
  const doc = await BlogTag.findByIdAndUpdate(
    id,
    { $set: { name: name.trim(), slug } },
    { returnDocument: "after" }
  ).lean();
  return doc ? shapeTag(doc) : null;
}

export async function deleteBlogTag(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await BlogTag.findById(id).exec();
  if (!doc) return null;
  // Pull the tag off any post that references it so nothing dangles.
  await Blog.updateMany({ tagIds: doc._id }, { $pull: { tagIds: doc._id } });
  await doc.deleteOne();
  return true;
}
