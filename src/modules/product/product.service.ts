import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Product,
  ProductDocument,
  ProductStatus,
  Category,
  Brand,
  Media,
  MediaDocument,
} from "../../database/models";
import { attachMediaToEntity, detachMedia } from "../media/media.service";
import { getStorageProvider } from "../media/media.storage";
import { slugify } from "../../common/utils/slugify";
import type { CreateProductInput, UpdateProductInput } from "./product.validation";

const storage = getStorageProvider();

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Money-safe discount calculation ----
// Spec §14/§45: discount/discountPercentage are always derived, never stored,
// and never computed with naive floating-point subtraction/division. Values
// are converted to integer minor units (paise) first, the arithmetic is done
// on integers, and only the final result is converted back — the same
// "integer minor units for money math" principle the spec asks for, applied
// at calculation time even though the schema stores rupee-denominated
// numbers (matching every other price value already in this codebase, e.g.
// components/sections/product-data.ts, none of which use minor units).
export function computeDiscount(mrp: number, sellingPrice: number): { discount: number; discountPercentage: number } {
  const mrpMinor = Math.round(mrp * 100);
  const sellingMinor = Math.round(sellingPrice * 100);
  const discountMinor = Math.max(0, mrpMinor - sellingMinor);
  const discountPercentage = mrpMinor > 0 ? Math.round((discountMinor / mrpMinor) * 10000) / 100 : 0;
  return { discount: discountMinor / 100, discountPercentage };
}

// ---- Reference validation (direct model queries — see brand.service.ts's
// brandExistsAndActive comment for why this avoids a service-to-service
// circular import) ----

async function validateCategoryRef(categoryId: string): Promise<void> {
  if (!isValidObjectId(categoryId)) throw new AppError("Invalid category", 400);
  const category = await Category.findById(categoryId).select("isActive").lean();
  if (!category) throw new AppError("Category not found", 404);
  if (!category.isActive) throw new AppError("This category is inactive and cannot be assigned to products", 400);
}

async function validateBrandRef(brandId: string): Promise<void> {
  if (!isValidObjectId(brandId)) throw new AppError("Invalid brand", 400);
  const brand = await Brand.findById(brandId).select("isActive").lean();
  if (!brand) throw new AppError("Brand not found", 404);
  if (!brand.isActive) throw new AppError("This brand is inactive and cannot be assigned to products", 400);
}

async function ensureUniqueSlug(slug: string, excludeId?: string): Promise<void> {
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  const exists = await Product.exists(filter);
  if (exists) throw new AppError("A product with this slug already exists", 409);
}

// Normalizes independently of the Zod schema's own uppercase transform —
// the uniqueness pre-check has to compare against the exact form that will
// be persisted (the Mongoose schema also has `uppercase: true` on `sku`, so
// relying on the caller having already uppercased it would let a
// same-SKU-different-case pair slip past this check and hit the DB's unique
// index instead, surfacing as a raw Mongo E11000 error rather than a clean
// 409 AppError).
function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

async function ensureUniqueSku(sku: string, excludeId?: string): Promise<void> {
  const filter: Record<string, unknown> = { sku: normalizeSku(sku) };
  if (excludeId) filter._id = { $ne: excludeId };
  const exists = await Product.exists(filter);
  if (exists) throw new AppError("A product with this SKU already exists", 409);
}

// ---- Media sync (attach/detach/reorder/primary) ----
// Single entry point for every way a product's images can change: initial
// creation, adding/removing gallery images, reordering, and swapping the
// primary. The client always sends the FULL desired ordered list — the
// first id is the primary — and this reconciles it against whatever is
// currently attached, rather than exposing separate add/remove/reorder
// endpoints. See Product.model.ts's header comment for why ordering lives
// on Media (isPrimary/sortOrder) rather than a mediaIds array on Product.
async function syncProductMedia(productId: string, mediaIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(mediaIds)];
  const mediaDocs = await Media.find({ _id: { $in: uniqueIds } }).exec();
  if (mediaDocs.length !== uniqueIds.length) {
    throw new AppError("One or more selected images could not be found", 400);
  }
  const byId = new Map(mediaDocs.map((doc) => [doc._id.toString(), doc]));

  for (const id of uniqueIds) {
    const doc = byId.get(id)!;
    if (doc.mediaType !== "IMAGE") {
      throw new AppError("Only image media can be used for product photos", 400);
    }
    const attachedElsewhere =
      doc.status === "ATTACHED" &&
      !(doc.entityType === "PRODUCT" && doc.entityId?.toString() === productId);
    if (attachedElsewhere) {
      throw new AppError("One or more selected images are already attached to another item", 409);
    }
  }

  const currentlyAttached = await Media.find({ entityType: "PRODUCT", entityId: productId }).exec();
  const nextIdSet = new Set(uniqueIds);
  for (const doc of currentlyAttached) {
    if (!nextIdSet.has(doc._id.toString())) {
      await detachMedia(doc._id.toString());
    }
  }

  for (let i = 0; i < uniqueIds.length; i++) {
    const id = uniqueIds[i];
    await attachMediaToEntity(id, "PRODUCT", productId);
    await Media.updateOne({ _id: id }, { $set: { isPrimary: i === 0, sortOrder: i } });
  }
}

async function getProductImages(productId: string): Promise<MediaDocument[]> {
  return Media.find({ entityType: "PRODUCT", entityId: productId })
    .sort({ isPrimary: -1, sortOrder: 1 })
    .exec();
}

interface ProductImageInfo {
  mediaId: string;
  url: string;
  mediumUrl?: string;
  thumbnailUrl?: string;
  isPrimary: boolean;
  sortOrder: number;
}

function toImageInfo(media: MediaDocument): ProductImageInfo {
  const optimizedKey = media.variants ? media.variants.optimized.key : media.storageKey;
  return {
    mediaId: media._id.toString(),
    url: storage.getUrl(optimizedKey),
    mediumUrl: media.variants ? storage.getUrl(media.variants.medium.key) : undefined,
    thumbnailUrl: media.variants ? storage.getUrl(media.variants.thumbnail.key) : undefined,
    isPrimary: media.isPrimary,
    sortOrder: media.sortOrder,
  };
}

// Batch primary-image lookup for callers that only need a single URL per
// product and can't use the richer DTOs above — currently checkout, which
// SNAPSHOTS the URL onto each order line item (see Order.model.ts). Same
// { entityType: "PRODUCT", isPrimary: true } query and same optimized-variant
// URL derivation as hydratePublicListItems/toImageInfo, kept here so image
// resolution stays in one module rather than being re-derived per feature.
export async function getPrimaryImageUrlMap(
  productIds: (string | mongoose.Types.ObjectId)[]
): Promise<Map<string, string>> {
  if (!productIds.length) return new Map();
  const images = await Media.find({
    entityType: "PRODUCT",
    entityId: { $in: productIds },
    isPrimary: true,
  }).exec();
  return new Map(
    images.map((m) => [
      m.entityId!.toString(),
      storage.getUrl(m.variants ? m.variants.optimized.key : m.storageKey),
    ])
  );
}

// ---- Activation guard ----
// Spec §33/§39: a product must never become ACTIVE while missing or invalid
// required data, even though the create schema already forces every
// mandatory field to be present up front — this is the defensive re-check at
// the moment of activation (covers the category/brand being deactivated or
// deleted after this product was created, and is the single choke point any
// future code path that flips status must also go through).
async function assertReadyForActivation(doc: ProductDocument): Promise<void> {
  const problems: string[] = [];

  if (!doc.name?.trim()) problems.push("name");
  if (!doc.slug?.trim()) problems.push("slug");
  if (!doc.sku?.trim()) problems.push("SKU");
  if (!doc.shortDescription?.trim()) problems.push("short description");
  if (!doc.description?.trim()) problems.push("description");

  const [category, brand] = await Promise.all([
    Category.findById(doc.categoryId).select("isActive").lean(),
    Brand.findById(doc.brandId).select("isActive").lean(),
  ]);
  if (!category || !category.isActive) problems.push("a valid, active category");
  if (!brand || !brand.isActive) problems.push("a valid, active brand");

  if (!doc.pricing || !(doc.pricing.mrp > 0) || !(doc.pricing.sellingPrice > 0) || doc.pricing.sellingPrice > doc.pricing.mrp) {
    problems.push("valid pricing (selling price must be greater than 0 and not exceed MRP)");
  }
  if (!doc.inventory || doc.inventory.stockQuantity == null || doc.inventory.stockQuantity < 0) {
    problems.push("valid inventory");
  }
  if (!doc.seo?.title?.trim() || !doc.seo?.description?.trim() || !doc.seo?.keywords?.length) {
    problems.push("complete SEO details (title, description, and at least one keyword)");
  }

  const imageCount = await Media.countDocuments({ entityType: "PRODUCT", entityId: doc._id });
  if (imageCount === 0) problems.push("at least one product image");

  if (problems.length > 0) {
    throw new AppError(`This product cannot be activated — missing or invalid: ${problems.join(", ")}.`, 409, true, {
      missing: problems,
    });
  }
}

// ---- Response shaping ----

type LeanProduct = Pick<
  ProductDocument,
  | "name"
  | "slug"
  | "sku"
  | "shortDescription"
  | "description"
  | "categoryId"
  | "brandId"
  | "pricing"
  | "inventory"
  | "seo"
  | "status"
  | "isFeatured"
  | "sortOrder"
  | "createdBy"
  | "updatedBy"
  | "createdAt"
  | "updatedAt"
> & { _id: mongoose.Types.ObjectId };

function toListItem(
  doc: LeanProduct,
  categoryName: string | undefined,
  brandName: string | undefined,
  primaryImage: MediaDocument | undefined
) {
  const { discount, discountPercentage } = computeDiscount(doc.pricing.mrp, doc.pricing.sellingPrice);
  return {
    productId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    sku: doc.sku,
    shortDescription: doc.shortDescription,
    category: { id: doc.categoryId.toString(), name: categoryName ?? null },
    brand: { id: doc.brandId.toString(), name: brandName ?? null },
    image: primaryImage ? toImageInfo(primaryImage) : null,
    pricing: { ...doc.pricing, discount, discountPercentage },
    inventory: doc.inventory,
    status: doc.status,
    isFeatured: doc.isFeatured,
    sortOrder: doc.sortOrder,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function toDetailItem(doc: ProductDocument) {
  const [category, brand, images] = await Promise.all([
    Category.findById(doc.categoryId).select("name slug").lean(),
    Brand.findById(doc.brandId).select("name slug").lean(),
    getProductImages(doc._id.toString()),
  ]);
  const { discount, discountPercentage } = computeDiscount(doc.pricing.mrp, doc.pricing.sellingPrice);

  return {
    productId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    sku: doc.sku,
    shortDescription: doc.shortDescription,
    description: doc.description,
    category: category ? { id: category._id.toString(), name: category.name, slug: category.slug } : null,
    brand: brand ? { id: brand._id.toString(), name: brand.name, slug: brand.slug } : null,
    categoryId: doc.categoryId.toString(),
    brandId: doc.brandId.toString(),
    images: images.map(toImageInfo),
    // Built as plain object literals rather than doc.pricing.toObject() etc.
    // — ProductPricing/ProductInventory/ProductSeo are plain TS interfaces
    // (see Product.model.ts), not typed Mongoose subdocument classes, so
    // .toObject() isn't in their type even though it exists at runtime.
    // Picking the known fields explicitly is just as safe and keeps tsc happy.
    pricing: {
      mrp: doc.pricing.mrp,
      sellingPrice: doc.pricing.sellingPrice,
      costPrice: doc.pricing.costPrice,
      discount,
      discountPercentage,
    },
    inventory: {
      stockQuantity: doc.inventory.stockQuantity,
      lowStockThreshold: doc.inventory.lowStockThreshold,
      trackInventory: doc.inventory.trackInventory,
    },
    seo: {
      title: doc.seo.title,
      description: doc.seo.description,
      keywords: doc.seo.keywords,
      canonicalUrl: doc.seo.canonicalUrl,
      ogTitle: doc.seo.ogTitle,
      ogDescription: doc.seo.ogDescription,
      ogImageMediaId: doc.seo.ogImageMediaId ? doc.seo.ogImageMediaId.toString() : undefined,
    },
    status: doc.status,
    isFeatured: doc.isFeatured,
    sortOrder: doc.sortOrder,
    createdBy: doc.createdBy ? doc.createdBy.toString() : null,
    updatedBy: doc.updatedBy ? doc.updatedBy.toString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ---- Create ----

export async function createProduct(input: CreateProductInput, actorId?: string) {
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new AppError("Could not derive a valid slug from the provided name", 400);

  const sku = normalizeSku(input.sku);
  await Promise.all([validateCategoryRef(input.categoryId), validateBrandRef(input.brandId)]);
  await Promise.all([ensureUniqueSlug(slug), ensureUniqueSku(sku)]);

  const doc = await Product.create({
    name: input.name,
    slug,
    sku,
    shortDescription: input.shortDescription,
    description: input.description,
    categoryId: input.categoryId,
    brandId: input.brandId,
    pricing: input.pricing,
    inventory: {
      stockQuantity: input.inventory.stockQuantity,
      lowStockThreshold: input.inventory.lowStockThreshold ?? 10,
      trackInventory: input.inventory.trackInventory ?? true,
    },
    seo: {
      title: input.seo.title,
      description: input.seo.description,
      keywords: input.seo.keywords,
      canonicalUrl: input.seo.canonicalUrl,
      ogTitle: input.seo.ogTitle,
      ogDescription: input.seo.ogDescription,
      ogImageMediaId: input.seo.ogImageMediaId ? new mongoose.Types.ObjectId(input.seo.ogImageMediaId) : undefined,
    },
    status: input.status ?? "DRAFT",
    isFeatured: input.isFeatured ?? false,
    sortOrder: input.sortOrder ?? 0,
    createdBy: actorId,
    updatedBy: actorId,
  });

  try {
    await syncProductMedia(doc._id.toString(), input.mediaIds);
    if (doc.status === "ACTIVE") {
      await assertReadyForActivation(doc);
    }
  } catch (err) {
    // Compensating action in place of a real Mongo transaction — same
    // rationale as category.service.ts / brand.service.ts: standalone dev
    // DB, no replica set, nothing else in this codebase uses transactions.
    const attached = await Media.find({ entityType: "PRODUCT", entityId: doc._id }).exec();
    for (const m of attached) await detachMedia(m._id.toString());
    await doc.deleteOne();
    throw err;
  }

  return getProductById(doc._id.toString());
}

// ---- Update ----

export async function updateProductById(id: string, patch: UpdateProductInput, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Product.findById(id).exec();
  if (!doc) return null;

  if (patch.categoryId !== undefined) {
    await validateCategoryRef(patch.categoryId);
    doc.categoryId = new mongoose.Types.ObjectId(patch.categoryId);
  }
  if (patch.brandId !== undefined) {
    await validateBrandRef(patch.brandId);
    doc.brandId = new mongoose.Types.ObjectId(patch.brandId);
  }

  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.shortDescription !== undefined) doc.shortDescription = patch.shortDescription;
  if (patch.description !== undefined) doc.description = patch.description;
  if (patch.isFeatured !== undefined) doc.isFeatured = patch.isFeatured;
  if (patch.sortOrder !== undefined) doc.sortOrder = patch.sortOrder;

  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug);
    if (!slug) throw new AppError("Invalid slug", 400);
    await ensureUniqueSlug(slug, id);
    doc.slug = slug;
  }

  if (patch.sku !== undefined) {
    const sku = normalizeSku(patch.sku);
    await ensureUniqueSku(sku, id);
    doc.sku = sku;
  }

  // Object.assign onto the existing Mongoose subdocument (not a full
  // reassignment built from a spread of `doc.pricing`/etc.) — single-nested
  // subdocuments don't reliably spread as plain objects, but they do support
  // in-place property assignment, which Mongoose tracks correctly for save().
  if (patch.pricing) {
    const current = { mrp: doc.pricing.mrp, sellingPrice: doc.pricing.sellingPrice, costPrice: doc.pricing.costPrice };
    const nextPricing = { ...current, ...patch.pricing };
    if (nextPricing.sellingPrice > nextPricing.mrp) {
      throw new AppError("Selling price cannot be greater than MRP", 400);
    }
    Object.assign(doc.pricing, patch.pricing);
  }

  if (patch.inventory) {
    Object.assign(doc.inventory, patch.inventory);
  }

  if (patch.seo) {
    Object.assign(doc.seo, patch.seo);
    if (patch.seo.ogImageMediaId !== undefined) {
      doc.seo.ogImageMediaId = patch.seo.ogImageMediaId
        ? new mongoose.Types.ObjectId(patch.seo.ogImageMediaId)
        : undefined;
    }
  }

  const nextStatus: ProductStatus | undefined = patch.status;
  if (nextStatus !== undefined) doc.status = nextStatus;

  if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);

  // Media sync happens before the activation check (which counts attached
  // images) so a request that adds images and flips status=ACTIVE in the
  // same call is evaluated against the *new* gallery, not the stale one.
  // If assertReadyForActivation then throws for an unrelated reason, the
  // media attachment already committed (no multi-document transactions in
  // this codebase — see the compensating-action comments in createProduct/
  // category.service.ts) but attachMediaToEntity is a no-op on retry, so a
  // second, corrected save is safe and idempotent.
  if (patch.mediaIds !== undefined) {
    await syncProductMedia(id, patch.mediaIds);
  }

  if (nextStatus === "ACTIVE") {
    await assertReadyForActivation(doc);
  }

  await doc.save();
  return getProductById(id);
}

// ---- Duplicate ----
// Spec §27: implemented because it fits the existing architecture cleanly.
// The clone gets fresh unique slug/SKU, always starts as DRAFT regardless of
// the source status, and deliberately starts with NO images — Media
// attachment is single-owner (see media.service.ts), so copying the
// original's image references would mean either sharing them (breaking that
// invariant) or silently detaching them from the original. Starting empty
// forces a conscious choice, which is safer than either alternative.
export async function duplicateProductById(id: string, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const original = await Product.findById(id).exec();
  if (!original) return null;

  let slug = `${original.slug}-copy`;
  for (let n = 2; await Product.exists({ slug }); n++) {
    slug = `${original.slug}-copy-${n}`;
  }
  let sku = `${original.sku}-COPY`;
  for (let n = 2; await Product.exists({ sku }); n++) {
    sku = `${original.sku}-COPY-${n}`;
  }

  const clone = await Product.create({
    name: `${original.name} (Copy)`,
    slug,
    sku,
    shortDescription: original.shortDescription,
    description: original.description,
    categoryId: original.categoryId,
    brandId: original.brandId,
    pricing: {
      mrp: original.pricing.mrp,
      sellingPrice: original.pricing.sellingPrice,
      costPrice: original.pricing.costPrice,
    },
    inventory: {
      stockQuantity: 0,
      lowStockThreshold: original.inventory.lowStockThreshold,
      trackInventory: original.inventory.trackInventory,
    },
    seo: {
      title: original.seo.title,
      description: original.seo.description,
      keywords: original.seo.keywords,
      canonicalUrl: original.seo.canonicalUrl,
      ogTitle: original.seo.ogTitle,
      ogDescription: original.seo.ogDescription,
      ogImageMediaId: original.seo.ogImageMediaId,
    },
    status: "DRAFT",
    isFeatured: false,
    sortOrder: original.sortOrder,
    createdBy: actorId,
    updatedBy: actorId,
  });

  return getProductById(clone._id.toString());
}

// ---- Delete ----
// Spec §34: never destroy a product that may already have real-world
// references. No Order/Cart/Review module exists yet in this codebase to
// check directly, so the conservative proxy is status: a product that was
// ever ACTIVE/INACTIVE/OUT_OF_STOCK (i.e. was live at some point) is archived
// instead of deleted. Only a product that never left DRAFT — or one that's
// already ARCHIVED and is being purged a second time — is actually removed.
export async function deleteProductById(id: string, actorId?: string): Promise<{ archived: boolean } | null> {
  if (!isValidObjectId(id)) return null;
  const doc = await Product.findById(id).exec();
  if (!doc) return null;

  if (doc.status === "DRAFT" || doc.status === "ARCHIVED") {
    const attached = await Media.find({ entityType: "PRODUCT", entityId: id }).exec();
    for (const m of attached) await detachMedia(m._id.toString());
    await doc.deleteOne();
    return { archived: false };
  }

  doc.status = "ARCHIVED";
  if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);
  await doc.save();
  return { archived: true };
}

// ---- Read ----

const SORTABLE_FIELDS = ["name", "createdAt", "sortOrder", "price", "stock"] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];
const SORT_FIELD_MAP: Record<SortableField, string> = {
  name: "name",
  createdAt: "createdAt",
  sortOrder: "sortOrder",
  price: "pricing.sellingPrice",
  stock: "inventory.stockQuantity",
};

export interface ProductListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  categoryId?: unknown;
  brandId?: unknown;
  status?: unknown;
  isFeatured?: unknown;
  minPrice?: unknown;
  maxPrice?: unknown;
  inStock?: unknown;
  sort?: unknown;
  order?: unknown;
}

function buildFilter(params: ProductListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ name: pattern }, { sku: pattern }, { slug: pattern }];
  }
  if (typeof params.categoryId === "string" && isValidObjectId(params.categoryId)) {
    filter.categoryId = params.categoryId;
  }
  if (typeof params.brandId === "string" && isValidObjectId(params.brandId)) {
    filter.brandId = params.brandId;
  }
  if (typeof params.status === "string" && ["DRAFT", "ACTIVE", "INACTIVE", "OUT_OF_STOCK", "ARCHIVED"].includes(params.status)) {
    filter.status = params.status;
  }
  if (params.isFeatured === "true") filter.isFeatured = true;
  else if (params.isFeatured === "false") filter.isFeatured = false;

  const priceFilter: Record<string, number> = {};
  if (typeof params.minPrice === "string" && params.minPrice.trim() && !Number.isNaN(Number(params.minPrice))) {
    priceFilter.$gte = Number(params.minPrice);
  }
  if (typeof params.maxPrice === "string" && params.maxPrice.trim() && !Number.isNaN(Number(params.maxPrice))) {
    priceFilter.$lte = Number(params.maxPrice);
  }
  if (Object.keys(priceFilter).length > 0) filter["pricing.sellingPrice"] = priceFilter;

  if (params.inStock === "true") {
    // A sibling $and (not reusing $or, which `search` above may already
    // occupy) — every top-level key in a MongoDB filter is implicitly
    // AND-ed together, so this composes safely with an active search term.
    filter.$and = [{ $or: [{ "inventory.trackInventory": false }, { "inventory.stockQuantity": { $gt: 0 } }] }];
  } else if (params.inStock === "false") {
    filter["inventory.trackInventory"] = true;
    filter["inventory.stockQuantity"] = { $lte: 0 };
  }

  return filter;
}

export async function getProductList(params: ProductListParams) {
  const { page, pageSize, sort, order } = params;
  const field: SortableField =
    typeof sort === "string" && (SORTABLE_FIELDS as readonly string[]).includes(sort) ? (sort as SortableField) : "createdAt";
  const direction: 1 | -1 = order === "asc" ? 1 : -1;
  const filter = buildFilter(params);

  const [docs, total] = await Promise.all([
    Product.find(filter)
      .sort({ [SORT_FIELD_MAP[field]]: direction })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Product.countDocuments(filter),
  ]);

  const productIds = docs.map((d) => d._id);
  const categoryIds = [...new Set(docs.map((d) => d.categoryId.toString()))];
  const brandIds = [...new Set(docs.map((d) => d.brandId.toString()))];

  const [categories, brands, primaryImages] = await Promise.all([
    categoryIds.length ? Category.find({ _id: { $in: categoryIds } }).select("name").lean() : [],
    brandIds.length ? Brand.find({ _id: { $in: brandIds } }).select("name").lean() : [],
    productIds.length
      ? Media.find({ entityType: "PRODUCT", entityId: { $in: productIds }, isPrimary: true }).exec()
      : [],
  ]);
  const categoryMap = new Map(categories.map((c) => [c._id.toString(), c.name]));
  const brandMap = new Map(brands.map((b) => [b._id.toString(), b.name]));
  const imageMap = new Map(primaryImages.map((m) => [m.entityId!.toString(), m]));

  return {
    items: docs.map((d) =>
      toListItem(
        d as unknown as LeanProduct,
        categoryMap.get(d.categoryId.toString()),
        brandMap.get(d.brandId.toString()),
        imageMap.get(d._id.toString())
      )
    ),
    page,
    pageSize,
    total,
    sort: field,
    order: direction === 1 ? "asc" : "desc",
  };
}

export async function getProductById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Product.findById(id).exec();
  if (!doc) return null;
  return toDetailItem(doc);
}

// ---- Cross-module integration points ----
// Exported for category.service.ts's delete guard and the admin dashboard's
// "Total Products" stat — direct Product.countDocuments() calls rather than
// those modules importing the rest of this service, so nothing here needs
// to import category.service.ts/adminDashboard.data.ts back (no cycle).

export async function countProductsInCategory(categoryId: string): Promise<number> {
  if (!isValidObjectId(categoryId)) return 0;
  return Product.countDocuments({ categoryId });
}

export async function countAllProducts(): Promise<number> {
  return Product.countDocuments();
}

// ============================================================================
// ---- Public catalog (customer-facing) ----
// Same Product model + collection as the admin functions above (per spec:
// "Admin Product Management and Customer Product Catalog should use the same
// domain/service layer where possible... never expose admin-only fields just
// because the same service is being used"). Everything below returns a
// DIFFERENT, deliberately smaller DTO shape than toListItem/toDetailItem —
// no costPrice, no createdBy/updatedBy, no raw status enum, no SKU on list
// cards — and every query is hard-filtered to PUBLIC_STATUSES so a DRAFT,
// INACTIVE, or ARCHIVED product can never be reached by slug or listed here,
// regardless of what filters the client sends.
// ============================================================================

// A product is only ever customer-visible in these two statuses. OUT_OF_STOCK
// is deliberately included (spec §34: an out-of-stock product stays viewable,
// just not purchasable) — DRAFT/INACTIVE/ARCHIVED are not, on any route.
const PUBLIC_STATUSES: ProductStatus[] = ["ACTIVE", "OUT_OF_STOCK"];

const PUBLIC_SORT_FIELDS = ["relevance", "price", "name", "createdAt"] as const;
type PublicSortField = (typeof PUBLIC_SORT_FIELDS)[number];

interface PublicProductImage {
  mediaId: string;
  url: string;
  mediumUrl?: string;
  thumbnailUrl?: string;
  altText: string;
}

function toPublicImage(media: MediaDocument | undefined, fallbackAlt: string): PublicProductImage | null {
  if (!media) return null;
  const optimizedKey = media.variants ? media.variants.optimized.key : media.storageKey;
  return {
    mediaId: media._id.toString(),
    url: storage.getUrl(optimizedKey),
    mediumUrl: media.variants ? storage.getUrl(media.variants.medium.key) : undefined,
    thumbnailUrl: media.variants ? storage.getUrl(media.variants.thumbnail.key) : undefined,
    altText: media.altText || fallbackAlt,
  };
}

interface PublicListDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  shortDescription: string;
  categoryId: mongoose.Types.ObjectId;
  brandId: mongoose.Types.ObjectId;
  pricing: { mrp: number; sellingPrice: number };
  inventory: { stockQuantity: number; lowStockThreshold: number; trackInventory: boolean };
  isFeatured: boolean;
  createdAt: Date;
}

// Shared by getPublicProductList and getRelatedProducts — one place doing the
// batch category/brand/primary-image lookups (2-3 queries total, never N+1)
// and shaping the customer-safe summary DTO.
async function hydratePublicListItems(docs: PublicListDoc[]) {
  const productIds = docs.map((d) => d._id);
  const categoryIds = [...new Set(docs.map((d) => d.categoryId.toString()))];
  const brandIds = [...new Set(docs.map((d) => d.brandId.toString()))];

  const [categories, brands, primaryImages] = await Promise.all([
    categoryIds.length ? Category.find({ _id: { $in: categoryIds } }).select("name slug").lean() : [],
    brandIds.length ? Brand.find({ _id: { $in: brandIds } }).select("name slug").lean() : [],
    productIds.length
      ? Media.find({ entityType: "PRODUCT", entityId: { $in: productIds }, isPrimary: true }).exec()
      : [],
  ]);
  const categoryMap = new Map(categories.map((c) => [c._id.toString(), c]));
  const brandMap = new Map(brands.map((b) => [b._id.toString(), b]));
  const imageMap = new Map(primaryImages.map((m) => [m.entityId!.toString(), m]));

  return docs.map((d) => {
    const category = categoryMap.get(d.categoryId.toString());
    const brand = brandMap.get(d.brandId.toString());
    const { discountPercentage } = computeDiscount(d.pricing.mrp, d.pricing.sellingPrice);
    const inStock = !d.inventory.trackInventory || d.inventory.stockQuantity > 0;
    const lowStock =
      d.inventory.trackInventory && d.inventory.stockQuantity > 0 && d.inventory.stockQuantity <= d.inventory.lowStockThreshold;

    return {
      productId: d._id.toString(),
      name: d.name,
      slug: d.slug,
      shortDescription: d.shortDescription,
      category: category ? { categoryId: category._id.toString(), name: category.name, slug: category.slug } : null,
      brand: brand ? { brandId: brand._id.toString(), name: brand.name, slug: brand.slug } : null,
      image: toPublicImage(imageMap.get(d._id.toString()), d.name),
      pricing: {
        mrp: d.pricing.mrp,
        sellingPrice: d.pricing.sellingPrice,
        discountPercentage,
      },
      // trackInventory is a policy flag, not a sensitive quantity — exposed
      // so the frontend's quantity-selector cap only applies to products
      // that actually track stock (an untracked product's stockQuantity is
      // not meaningful and must never gate the UI).
      inventory: { inStock, stockQuantity: d.inventory.stockQuantity, lowStock, trackInventory: d.inventory.trackInventory },
    };
  });
}

// Explicit switch (spec §42: never pass a raw sort/order query param into
// MongoDB) — every branch is a fixed, known field. "relevance" (the default,
// and the only sensible one when a search term or no sort is given) is
// approximated as featured-first-then-newest, since this codebase has no
// full-text index/search engine yet (see buildPublicFilter's search branch).
function buildPublicSort(sort: unknown, order: unknown): Record<string, 1 | -1> {
  const direction: 1 | -1 = order === "desc" ? -1 : 1;
  switch (sort) {
    case "price":
      return { "pricing.sellingPrice": direction };
    case "name":
      return { name: direction };
    case "createdAt":
      return { createdAt: direction };
    case "relevance":
    default:
      return { isFeatured: -1, createdAt: -1 };
  }
}

export interface PublicProductListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  categorySlug?: unknown;
  brandSlug?: unknown;
  minPrice?: unknown;
  maxPrice?: unknown;
  inStock?: unknown;
  sort?: unknown;
  order?: unknown;
}

// categorySlug/brandSlug (not ids) because the public API is slug-first end
// to end — customers and /category/:slug never see a Mongo ObjectId. An
// unknown slug resolves to a filter that can never match (rather than an
// error), so a stale/mistyped filter in a shared link just yields an empty
// grid instead of a 400.
async function buildPublicFilter(params: PublicProductListParams): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { status: { $in: PUBLIC_STATUSES } };

  if (typeof params.categorySlug === "string" && params.categorySlug.trim()) {
    const category = await Category.findOne({ slug: params.categorySlug.trim(), isActive: true })
      .select("_id")
      .lean();
    filter.categoryId = category ? category._id : null;
  }
  if (typeof params.brandSlug === "string" && params.brandSlug.trim()) {
    const brand = await Brand.findOne({ slug: params.brandSlug.trim(), isActive: true }).select("_id").lean();
    filter.brandId = brand ? brand._id : null;
  }

  const priceFilter: Record<string, number> = {};
  if (typeof params.minPrice === "string" && params.minPrice.trim() && !Number.isNaN(Number(params.minPrice))) {
    priceFilter.$gte = Number(params.minPrice);
  }
  if (typeof params.maxPrice === "string" && params.maxPrice.trim() && !Number.isNaN(Number(params.maxPrice))) {
    priceFilter.$lte = Number(params.maxPrice);
  }
  if (Object.keys(priceFilter).length > 0) filter["pricing.sellingPrice"] = priceFilter;

  // Publicly, "availability" only ever narrows to in-stock — there's no
  // legitimate storefront reason to filter *for* out-of-stock items, unlike
  // the admin list which supports both directions.
  if (params.inStock === "true") {
    filter["inventory.stockQuantity"] = { $gt: 0 };
  }

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    // Spec §8: search should match product name, brand, category, and SKU —
    // not just a substring of the product document itself, so category/brand
    // names matching the term are resolved to ids first and OR'd in too.
    const [matchedCategories, matchedBrands] = await Promise.all([
      Category.find({ name: pattern }).select("_id").lean(),
      Brand.find({ name: pattern }).select("_id").lean(),
    ]);
    const or: Record<string, unknown>[] = [{ name: pattern }, { sku: pattern }, { shortDescription: pattern }];
    if (matchedCategories.length) or.push({ categoryId: { $in: matchedCategories.map((c) => c._id) } });
    if (matchedBrands.length) or.push({ brandId: { $in: matchedBrands.map((b) => b._id) } });
    filter.$and = [{ $or: or }];
  }

  return filter;
}

export async function getPublicProductList(params: PublicProductListParams) {
  const { page, pageSize, sort, order } = params;
  const filter = await buildPublicFilter(params);
  const sortSpec = buildPublicSort(sort, order);

  const [docs, total] = await Promise.all([
    Product.find(filter)
      .select("name slug shortDescription categoryId brandId pricing inventory isFeatured createdAt")
      .sort(sortSpec)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Product.countDocuments(filter),
  ]);

  const resolvedSort: PublicSortField =
    typeof sort === "string" && (PUBLIC_SORT_FIELDS as readonly string[]).includes(sort) ? (sort as PublicSortField) : "relevance";

  return {
    items: await hydratePublicListItems(docs as unknown as PublicListDoc[]),
    page,
    pageSize,
    total,
    sort: resolvedSort,
    order: order === "desc" ? "desc" : "asc",
  };
}

export async function getPublicProductBySlug(slug: string) {
  const doc = await Product.findOne({ slug, status: { $in: PUBLIC_STATUSES } }).exec();
  if (!doc) return null;

  const [category, brand, images] = await Promise.all([
    Category.findById(doc.categoryId).select("name slug").lean(),
    Brand.findById(doc.brandId).select("name slug").lean(),
    getProductImages(doc._id.toString()),
  ]);

  const { discountPercentage } = computeDiscount(doc.pricing.mrp, doc.pricing.sellingPrice);
  const inStock = !doc.inventory.trackInventory || doc.inventory.stockQuantity > 0;
  const lowStock =
    doc.inventory.trackInventory &&
    doc.inventory.stockQuantity > 0 &&
    doc.inventory.stockQuantity <= doc.inventory.lowStockThreshold;

  return {
    productId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    sku: doc.sku,
    shortDescription: doc.shortDescription,
    description: doc.description,
    category: category ? { categoryId: category._id.toString(), name: category.name, slug: category.slug } : null,
    brand: brand ? { brandId: brand._id.toString(), name: brand.name, slug: brand.slug } : null,
    images: images
      .map((m) => toPublicImage(m, doc.name))
      .filter((img): img is PublicProductImage => img !== null),
    pricing: {
      mrp: doc.pricing.mrp,
      sellingPrice: doc.pricing.sellingPrice,
      discountPercentage,
    },
    inventory: { inStock, stockQuantity: doc.inventory.stockQuantity, lowStock, trackInventory: doc.inventory.trackInventory },
    seo: {
      title: doc.seo.title,
      description: doc.seo.description,
      keywords: doc.seo.keywords,
      canonicalUrl: doc.seo.canonicalUrl,
      ogTitle: doc.seo.ogTitle,
      ogDescription: doc.seo.ogDescription,
    },
  };
}

// Same-category first (primary signal), backfilled with same-brand products
// if the category alone doesn't yield enough — never fetches the whole
// catalog to compute this client-side (spec §24).
export async function getRelatedProducts(slug: string, limit = 8) {
  const source = await Product.findOne({ slug, status: { $in: PUBLIC_STATUSES } })
    .select("categoryId brandId")
    .lean();
  if (!source) return [];

  const base = { status: { $in: PUBLIC_STATUSES }, _id: { $ne: source._id } };
  const projection = "name slug shortDescription categoryId brandId pricing inventory isFeatured createdAt";

  const sameCategory = await Product.find({ ...base, categoryId: source.categoryId })
    .select(projection)
    .sort({ isFeatured: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  let results = sameCategory;
  if (results.length < limit) {
    const excludeIds = [source._id, ...results.map((r) => r._id)];
    const sameBrand = await Product.find({ ...base, brandId: source.brandId, _id: { $nin: excludeIds } })
      .select(projection)
      .sort({ isFeatured: -1, createdAt: -1 })
      .limit(limit - results.length)
      .lean();
    results = [...results, ...sameBrand];
  }

  return hydratePublicListItems(results as unknown as PublicListDoc[]);
}

// Powers the public category-filter chip list and /category/:slug — reuses
// the same Product collection but only ever reports counts/products for the
// two customer-visible statuses.
export async function getPublicProductCountForCategory(categoryId: string): Promise<number> {
  if (!isValidObjectId(categoryId)) return 0;
  return Product.countDocuments({ categoryId, status: { $in: PUBLIC_STATUSES } });
}

// Powers the wishlist listing (wishlist.service.ts): User.wishlist is just
// string[] of product ids, with no guarantee every id still points at a
// public-visible product (it may have since gone DRAFT/ARCHIVED, or been
// deleted outright) — invalid/non-public ids are silently dropped here
// rather than erroring, same "never surface a non-public product" rule as
// buildPublicFilter/getPublicProductBySlug.
export async function getProductSummariesByIds(productIds: string[]) {
  const validIds = productIds.filter(isValidObjectId);
  if (!validIds.length) return [];

  const docs = await Product.find({ _id: { $in: validIds }, status: { $in: PUBLIC_STATUSES } })
    .select("name slug shortDescription categoryId brandId pricing inventory isFeatured createdAt")
    .lean();

  return hydratePublicListItems(docs as unknown as PublicListDoc[]);
}
