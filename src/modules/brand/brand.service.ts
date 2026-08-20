import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Brand, BrandDocument, Media, MediaDocument, Product } from "../../database/models";
import { getMediaDocById, attachMediaToEntity, detachMedia } from "../media/media.service";
import { getStorageProvider } from "../media/media.storage";
import { slugify } from "../../common/utils/slugify";
import type { CreateBrandInput, UpdateBrandInput } from "./brand.validation";

const storage = getStorageProvider();

// Same rationale as Category's MAX_CATEGORY_IMAGE_BYTES — brand logos are
// shown small (product cards, brand chips), so a stricter cap than the
// Media module's general upload limit keeps the admin from attaching a
// full-resolution photo that adds nothing visually but bloats page weight.
const MAX_BRAND_LOGO_BYTES = 1.5 * 1024 * 1024;

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface BrandLogoInfo {
  mediaId: string;
  url: string;
  thumbnailUrl?: string;
}

function toLogoInfo(media: MediaDocument | null | undefined): BrandLogoInfo | null {
  if (!media) return null;
  const optimizedKey = media.variants ? media.variants.optimized.key : media.storageKey;
  return {
    mediaId: media._id.toString(),
    url: storage.getUrl(optimizedKey),
    thumbnailUrl: media.variants ? storage.getUrl(media.variants.thumbnail.key) : undefined,
  };
}

type LeanBrand = Pick<
  BrandDocument,
  "name" | "slug" | "description" | "logoMediaId" | "isActive" | "sortOrder" | "createdAt" | "updatedAt"
> & { _id: mongoose.Types.ObjectId };

function toListItem(doc: LeanBrand, media: MediaDocument | null | undefined) {
  return {
    brandId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description ?? null,
    logo: toLogoInfo(media),
    isActive: doc.isActive,
    sortOrder: doc.sortOrder,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ---- Validation helpers ----

async function validateLogoMedia(logoMediaId: string): Promise<void> {
  if (!isValidObjectId(logoMediaId)) throw new AppError("Invalid media", 400);
  const media = await getMediaDocById(logoMediaId);
  if (!media) throw new AppError("Media not found", 400);
  if (media.mediaType !== "IMAGE") {
    throw new AppError("Only image media can be used as a brand logo", 400);
  }
  if (media.size > MAX_BRAND_LOGO_BYTES) {
    throw new AppError("Brand logo must be 1.5MB or smaller", 400);
  }
}

async function ensureUniqueSlug(slug: string, excludeId?: string): Promise<void> {
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  const exists = await Brand.exists(filter);
  if (exists) throw new AppError("A brand with this slug already exists", 409);
}

// ---- Create ----

export async function createBrand(input: CreateBrandInput, actorId?: string) {
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new AppError("Could not derive a valid slug from the provided name", 400);

  await ensureUniqueSlug(slug);
  if (input.logoMediaId) await validateLogoMedia(input.logoMediaId);

  const doc = await Brand.create({
    name: input.name,
    slug,
    description: input.description,
    logoMediaId: input.logoMediaId || undefined,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    createdBy: actorId,
    updatedBy: actorId,
  });

  if (input.logoMediaId) {
    try {
      await attachMediaToEntity(input.logoMediaId, "BRAND", doc._id.toString());
    } catch (err) {
      // Compensating action in place of a real Mongo transaction — same
      // rationale as category.service.ts: standalone dev DB, no replica set,
      // no multi-document transactions used elsewhere in this codebase.
      await doc.deleteOne();
      throw err;
    }
  }

  return getBrandById(doc._id.toString());
}

// ---- Update ----

export async function updateBrandById(id: string, patch: UpdateBrandInput, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Brand.findById(id).exec();
  if (!doc) return null;

  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.description !== undefined) doc.description = patch.description;
  if (patch.isActive !== undefined) doc.isActive = patch.isActive;
  if (patch.sortOrder !== undefined) doc.sortOrder = patch.sortOrder;

  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug);
    if (!slug) throw new AppError("Invalid slug", 400);
    await ensureUniqueSlug(slug, id);
    doc.slug = slug;
  }

  let previousLogoMediaId: string | undefined;
  let nextLogoMediaId: string | undefined;
  const logoProvided = patch.logoMediaId !== undefined;
  if (logoProvided) {
    previousLogoMediaId = doc.logoMediaId?.toString();
    if (patch.logoMediaId) {
      await validateLogoMedia(patch.logoMediaId);
      nextLogoMediaId = patch.logoMediaId;
      doc.logoMediaId = new mongoose.Types.ObjectId(patch.logoMediaId);
    } else {
      doc.logoMediaId = undefined;
    }
  }

  if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);
  await doc.save();

  if (logoProvided && nextLogoMediaId !== previousLogoMediaId) {
    if (nextLogoMediaId) await attachMediaToEntity(nextLogoMediaId, "BRAND", id);
    if (previousLogoMediaId) await detachMedia(previousLogoMediaId);
  }

  return getBrandById(id);
}

// ---- Delete ----

export async function deleteBrandById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Brand.findById(id).exec();
  if (!doc) return null;

  const productCount = await Product.countDocuments({ brandId: id });
  if (productCount > 0) {
    throw new AppError(
      `Cannot delete this brand — ${productCount} product${productCount === 1 ? "" : "s"} ${productCount === 1 ? "is" : "are"} assigned to it.`,
      409,
      true,
      { products: productCount }
    );
  }

  await doc.deleteOne();
  if (doc.logoMediaId) await detachMedia(doc.logoMediaId.toString());
  return true;
}

// ---- Read ----

const SORTABLE_FIELDS = ["createdAt", "name", "sortOrder"] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

export interface BrandListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  isActive?: unknown;
  sort?: unknown;
  order?: unknown;
}

function buildFilter(params: BrandListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ name: pattern }, { slug: pattern }];
  }
  if (params.isActive === "true") filter.isActive = true;
  else if (params.isActive === "false") filter.isActive = false;

  return filter;
}

export async function getBrandList(params: BrandListParams) {
  const { page, pageSize, sort, order } = params;
  const field: SortableField =
    typeof sort === "string" && (SORTABLE_FIELDS as readonly string[]).includes(sort)
      ? (sort as SortableField)
      : "sortOrder";
  const direction: 1 | -1 = order === "desc" ? -1 : 1;
  const filter = buildFilter(params);

  const [docs, total] = await Promise.all([
    Brand.find(filter)
      .sort({ [field]: direction })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Brand.countDocuments(filter),
  ]);

  const mediaIds = [...new Set(docs.map((d) => d.logoMediaId?.toString()).filter((v): v is string => Boolean(v)))];
  const mediaDocs = mediaIds.length ? await Media.find({ _id: { $in: mediaIds } }).exec() : [];
  const mediaMap = new Map(mediaDocs.map((m) => [m._id.toString(), m]));

  return {
    items: docs.map((d) => toListItem(d as unknown as LeanBrand, d.logoMediaId ? mediaMap.get(d.logoMediaId.toString()) : undefined)),
    page,
    pageSize,
    total,
    sort: field,
    order: direction === 1 ? "asc" : "desc",
  };
}

// Lightweight, unpaginated — powers the brand-selector dropdown on the
// Product form. Brand counts are small (dozens to low hundreds) so a single
// unpaginated query is the right tool, not a second paginated endpoint.
export async function getBrandOptions() {
  const docs = await Brand.find({ isActive: true }).select("name").sort({ name: 1 }).lean();
  return docs.map((d) => ({ id: d._id.toString(), name: d.name }));
}

export async function getBrandById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Brand.findById(id).lean();
  if (!doc) return null;

  const media = doc.logoMediaId ? await getMediaDocById(doc.logoMediaId.toString()) : null;
  return toListItem(doc as unknown as LeanBrand, media);
}

// Exported for Product creation/update to validate brandId without a second
// service-to-service dependency — a direct existence+active check, same
// shape as Category's validateParent().
export async function brandExistsAndActive(id: string): Promise<boolean> {
  if (!isValidObjectId(id)) return false;
  return Boolean(await Brand.exists({ _id: id, isActive: true }));
}

// ---- Public catalog (customer-facing) ----
// Powers the storefront's brand filter chips — active brands only, same
// toListItem shape already used by the admin list (name/slug/logo are all
// customer-safe; nothing admin-only is added by reusing it here).
export async function getPublicBrandList() {
  const docs = await Brand.find({ isActive: true }).select("name slug description logoMediaId").sort({ sortOrder: 1, name: 1 }).lean();

  const mediaIds = [...new Set(docs.map((d) => d.logoMediaId?.toString()).filter((v): v is string => Boolean(v)))];
  const mediaDocs = mediaIds.length ? await Media.find({ _id: { $in: mediaIds } }).exec() : [];
  const mediaMap = new Map(mediaDocs.map((m) => [m._id.toString(), m]));

  return docs.map((d) => ({
    brandId: d._id.toString(),
    name: d.name,
    slug: d.slug,
    description: d.description ?? null,
    logo: toLogoInfo(d.logoMediaId ? mediaMap.get(d.logoMediaId.toString()) : undefined),
  }));
}
