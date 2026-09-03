import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Category, CategoryDocument, Media, MediaDocument } from "../../database/models";
import { getMediaDocById, attachMediaToEntity, detachMedia } from "../media/media.service";
import { getStorageProvider } from "../media/media.storage";
import { countProductsInCategory } from "../product/product.service";
import { slugify } from "./slugify";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation";

const storage = getStorageProvider();

// A Category-specific business rule, not a Media-module limit — general
// media uploads elsewhere still allow up to the Media module's own
// MAX_IMAGE_FILE_SIZE_MB. Category images are shown small (nav tiles,
// listing thumbnails) so a stricter cap keeps the admin from attaching a
// full-resolution photo that adds nothing visually but bloats page weight.
const MAX_CATEGORY_IMAGE_BYTES = 1.5 * 1024 * 1024;

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CategoryImageInfo {
  mediaId: string;
  url: string;
  thumbnailUrl?: string;
}

function toImageInfo(media: MediaDocument | null | undefined): CategoryImageInfo | null {
  if (!media) return null;
  const optimizedKey = media.variants ? media.variants.optimized.key : media.storageKey;
  return {
    mediaId: media._id.toString(),
    url: storage.getUrl(optimizedKey),
    thumbnailUrl: media.variants ? storage.getUrl(media.variants.thumbnail.key) : undefined,
  };
}

type LeanCategory = Pick<
  CategoryDocument,
  | "name"
  | "collectionName"
  | "slug"
  | "description"
  | "parentId"
  | "imageMediaId"
  | "isActive"
  | "sortOrder"
  | "createdAt"
  | "updatedAt"
> & { _id: mongoose.Types.ObjectId };

function toListItem(
  doc: LeanCategory,
  parentName: string | undefined,
  media: MediaDocument | null | undefined
) {
  return {
    categoryId: doc._id.toString(),
    name: doc.name,
    collectionName: doc.collectionName ?? null,
    slug: doc.slug,
    description: doc.description ?? null,
    image: toImageInfo(media),
    parentId: doc.parentId ? doc.parentId.toString() : null,
    parentName: parentName ?? null,
    isActive: doc.isActive,
    sortOrder: doc.sortOrder,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toDetailItem(
  doc: LeanCategory,
  parent: { _id: mongoose.Types.ObjectId; name: string; slug: string } | null | undefined,
  media: MediaDocument | null | undefined
) {
  return {
    ...toListItem(doc, parent?.name, media),
    parent: parent ? { id: parent._id.toString(), name: parent.name, slug: parent.slug } : null,
  };
}

// ---- Validation helpers ----

async function validateParent(parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (!isValidObjectId(parentId)) throw new AppError("Invalid parent category", 400);
  const exists = await Category.exists({ _id: parentId });
  if (!exists) throw new AppError("Parent category not found", 400);
}

// Walks up the ancestor chain from `newParentId`; rejects if `categoryId`
// appears anywhere in it (including newParentId === categoryId directly).
async function wouldCreateCycle(categoryId: string, newParentId: string): Promise<boolean> {
  if (categoryId === newParentId) return true;
  let currentId: string | undefined = newParentId;
  const visited = new Set<string>();
  while (currentId) {
    if (currentId === categoryId) return true;
    if (visited.has(currentId)) break; // guards against any pre-existing bad data looping forever
    visited.add(currentId);
    const parent: { parentId?: mongoose.Types.ObjectId } | null = await Category.findById(currentId)
      .select("parentId")
      .lean();
    currentId = parent?.parentId ? parent.parentId.toString() : undefined;
  }
  return false;
}

async function validateImageMedia(imageMediaId: string): Promise<void> {
  if (!isValidObjectId(imageMediaId)) throw new AppError("Invalid media", 400);
  const media = await getMediaDocById(imageMediaId);
  if (!media) throw new AppError("Media not found", 400);
  if (media.mediaType !== "IMAGE") {
    throw new AppError("Only image media can be used as a category image", 400);
  }
  if (media.size > MAX_CATEGORY_IMAGE_BYTES) {
    throw new AppError("Category image must be 1.5MB or smaller", 400);
  }
}

async function ensureUniqueSlug(slug: string, excludeId?: string): Promise<void> {
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  const exists = await Category.exists(filter);
  if (exists) throw new AppError("A category with this slug already exists", 409);
}

// ---- Create ----

export async function createCategory(input: CreateCategoryInput) {
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new AppError("Could not derive a valid slug from the provided name", 400);

  await validateParent(input.parentId);
  await ensureUniqueSlug(slug);
  if (input.imageMediaId) await validateImageMedia(input.imageMediaId);

  const doc = await Category.create({
    name: input.name,
    collectionName: input.collectionName?.trim() || undefined,
    slug,
    description: input.description,
    parentId: input.parentId || undefined,
    imageMediaId: input.imageMediaId || undefined,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
  });

  if (input.imageMediaId) {
    try {
      await attachMediaToEntity(input.imageMediaId, "CATEGORY", doc._id.toString(), {
        field: "image",
      });
    } catch (err) {
      // Compensating action in place of a real Mongo transaction — this is a
      // standalone dev DB (no replica set), so multi-document transactions
      // aren't reliably available, and nothing else in this codebase uses
      // them. Roll back the category rather than leave a half-attached state.
      await doc.deleteOne();
      throw err;
    }
  }

  return getCategoryById(doc._id.toString());
}

// ---- Update ----

export async function updateCategoryById(id: string, patch: UpdateCategoryInput) {
  if (!isValidObjectId(id)) return null;
  const doc = await Category.findById(id).exec();
  if (!doc) return null;

  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.collectionName !== undefined) doc.collectionName = patch.collectionName.trim() || undefined;
  if (patch.description !== undefined) doc.description = patch.description;
  if (patch.isActive !== undefined) doc.isActive = patch.isActive;
  if (patch.sortOrder !== undefined) doc.sortOrder = patch.sortOrder;

  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug);
    if (!slug) throw new AppError("Invalid slug", 400);
    await ensureUniqueSlug(slug, id);
    doc.slug = slug;
  }

  if (patch.parentId !== undefined) {
    if (patch.parentId) {
      await validateParent(patch.parentId);
      if (await wouldCreateCycle(id, patch.parentId)) {
        throw new AppError("This would create a circular category hierarchy", 400);
      }
      doc.parentId = new mongoose.Types.ObjectId(patch.parentId);
    } else {
      doc.parentId = undefined;
    }
  }

  let previousImageMediaId: string | undefined;
  let nextImageMediaId: string | undefined;
  const imageProvided = patch.imageMediaId !== undefined;
  if (imageProvided) {
    previousImageMediaId = doc.imageMediaId?.toString();
    if (patch.imageMediaId) {
      await validateImageMedia(patch.imageMediaId);
      nextImageMediaId = patch.imageMediaId;
      doc.imageMediaId = new mongoose.Types.ObjectId(patch.imageMediaId);
    } else {
      doc.imageMediaId = undefined;
    }
  }

  await doc.save();

  if (imageProvided && nextImageMediaId !== previousImageMediaId) {
    if (nextImageMediaId) {
      await attachMediaToEntity(nextImageMediaId, "CATEGORY", id, { field: "image" });
    }
    if (previousImageMediaId) {
      await detachMedia(previousImageMediaId, { entityType: "CATEGORY", entityId: id, field: "image" });
    }
  }

  return getCategoryById(id);
}

// ---- Delete ----

export async function deleteCategoryById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Category.findById(id).exec();
  if (!doc) return null;

  const [childCount, productCount] = await Promise.all([
    Category.countDocuments({ parentId: id }),
    countProductsInCategory(id),
  ]);

  if (childCount > 0 || productCount > 0) {
    const message =
      childCount > 0
        ? `Cannot delete this category — ${childCount} subcategor${childCount === 1 ? "y" : "ies"} ${childCount === 1 ? "depends" : "depend"} on it.`
        : `Cannot delete this category — ${productCount} products are assigned to it.`;
    throw new AppError(message, 409, true, { childCategories: childCount, products: productCount });
  }

  await doc.deleteOne();
  if (doc.imageMediaId) {
    await detachMedia(doc.imageMediaId.toString(), { entityType: "CATEGORY", entityId: id });
  }
  return true;
}

// ---- Read ----

const SORTABLE_FIELDS = ["createdAt", "name", "sortOrder"] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

export interface CategoryListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  parentId?: unknown;
  isActive?: unknown;
  sort?: unknown;
  order?: unknown;
}

function buildFilter(params: CategoryListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ name: pattern }, { slug: pattern }];
  }
  if (typeof params.parentId === "string" && params.parentId === "root") {
    filter.parentId = { $exists: false };
  } else if (typeof params.parentId === "string" && isValidObjectId(params.parentId)) {
    filter.parentId = params.parentId;
  }
  if (params.isActive === "true") filter.isActive = true;
  else if (params.isActive === "false") filter.isActive = false;

  return filter;
}

export async function getCategoryList(params: CategoryListParams) {
  const { page, pageSize, sort, order } = params;
  const field: SortableField =
    typeof sort === "string" && (SORTABLE_FIELDS as readonly string[]).includes(sort)
      ? (sort as SortableField)
      : "sortOrder";
  const direction: 1 | -1 = order === "desc" ? -1 : 1;
  const filter = buildFilter(params);

  const [docs, total] = await Promise.all([
    Category.find(filter)
      .sort({ [field]: direction })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Category.countDocuments(filter),
  ]);

  // Batch-resolve parent names and image info for the whole page — two
  // queries total, not one per row.
  const parentIds = [...new Set(docs.map((d) => d.parentId?.toString()).filter((v): v is string => Boolean(v)))];
  const mediaIds = [...new Set(docs.map((d) => d.imageMediaId?.toString()).filter((v): v is string => Boolean(v)))];

  const [parents, mediaDocs] = await Promise.all([
    parentIds.length ? Category.find({ _id: { $in: parentIds } }).select("name").lean() : [],
    mediaIds.length ? Media.find({ _id: { $in: mediaIds } }).exec() : [],
  ]);
  const parentMap = new Map(parents.map((p) => [p._id.toString(), p.name]));
  const mediaMap = new Map(mediaDocs.map((m) => [m._id.toString(), m]));

  return {
    items: docs.map((d) =>
      toListItem(
        d as unknown as LeanCategory,
        d.parentId ? parentMap.get(d.parentId.toString()) : undefined,
        d.imageMediaId ? mediaMap.get(d.imageMediaId.toString()) : undefined
      )
    ),
    page,
    pageSize,
    total,
    sort: field,
    order: direction === 1 ? "asc" : "desc",
  };
}

// Lightweight, unpaginated — powers the parent-selector dropdown and the
// parent filter. Category counts are small (hundreds at most) so a single
// unpaginated query is the right tool here, not a second paginated endpoint.
export async function getCategoryOptions() {
  const docs = await Category.find({ isActive: true })
    .select("name parentId")
    .sort({ name: 1 })
    .lean();
  return docs.map((d) => ({
    id: d._id.toString(),
    name: d.name,
    parentId: d.parentId ? d.parentId.toString() : null,
  }));
}

export async function getCategoryById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Category.findById(id).lean();
  if (!doc) return null;

  const [parent, media] = await Promise.all([
    doc.parentId ? Category.findById(doc.parentId).select("name slug").lean() : null,
    doc.imageMediaId ? getMediaDocById(doc.imageMediaId.toString()) : null,
  ]);

  return toDetailItem(doc as unknown as LeanCategory, parent, media);
}

// ============================================================================
// ---- Public catalog (customer-facing) ----
// Same collection/model, deliberately smaller DTO: no parentId/parentName,
// no isActive/sortOrder/timestamps — categories that aren't isActive are
// filtered out entirely rather than returned with a flag, since an inactive
// category has no legitimate reason to be reachable from the storefront.
// ============================================================================

export async function getPublicCategoryList() {
  const docs = await Category.find({ isActive: true })
    .select("name collectionName slug description imageMediaId")
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  const mediaIds = [...new Set(docs.map((d) => d.imageMediaId?.toString()).filter((v): v is string => Boolean(v)))];
  const mediaDocs = mediaIds.length ? await Media.find({ _id: { $in: mediaIds } }).exec() : [];
  const mediaMap = new Map(mediaDocs.map((m) => [m._id.toString(), m]));

  return docs.map((d) => ({
    categoryId: d._id.toString(),
    name: d.name,
    collectionName: d.collectionName ?? null,
    slug: d.slug,
    description: d.description ?? null,
    image: toImageInfo(d.imageMediaId ? mediaMap.get(d.imageMediaId.toString()) : undefined),
  }));
}

export async function getPublicCategoryBySlug(slug: string) {
  const doc = await Category.findOne({ slug, isActive: true }).lean();
  if (!doc) return null;

  const media = doc.imageMediaId ? await getMediaDocById(doc.imageMediaId.toString()) : null;
  return {
    categoryId: doc._id.toString(),
    name: doc.name,
    collectionName: doc.collectionName ?? null,
    slug: doc.slug,
    description: doc.description ?? null,
    image: toImageInfo(media),
  };
}
