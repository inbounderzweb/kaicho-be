import crypto from "crypto";
import sharp from "sharp";
import { PDFParse } from "pdf-parse";
import mongoose from "mongoose";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import {
  Media,
  MediaDocument,
  MediaEntityType,
  MediaStatus,
  MediaType,
  MediaUsage,
  MediaUsageField,
  Product,
  Category,
  Brand,
  Collection,
  Blog,
  BlogCategory,
} from "../../database/models";
import { detectFileType, looksLikeValidPdfStructure } from "./fileSignature";
import { getStorageProvider } from "./media.storage";
import { logMediaEvent } from "./mediaLogger";
import type { UpdateMediaBody } from "./media.validation";

const storage = getStorageProvider();

// Hard ceiling on total input pixels, independent of MAX_IMAGE_WIDTH/HEIGHT —
// a generous buffer above the expected max legitimate dimensions (8000x8000
// = 64MP) so a genuinely-huge/decompression-bomb-style image is rejected
// outright, while anything within this buffer is let through and then
// resized down to the configured max per spec (never rejected just for
// being somewhat over 8000px on one side).
const DECOMPRESSION_BOMB_PIXEL_LIMIT = 100_000_000;

// pdf-parse reports a page count from PDF structure without executing any
// embedded content. A page count this large is almost certainly a malformed
// or adversarial file rather than a legitimate document.
const MAX_SANE_PDF_PAGE_COUNT = 2000;

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function storageKeyPrefix(category: "images" | "documents"): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const id = crypto.randomUUID();
  return `${category}/${yyyy}/${mm}/${id}`;
}

interface VariantResult {
  buffer: Buffer;
  key: string;
  width: number;
  height: number;
  size: number;
}

async function makeVariant(
  sourceBuffer: Buffer,
  keyPrefix: string,
  variantName: "thumbnail" | "medium" | "optimized",
  targetWidth: number,
  hasAlpha: boolean
): Promise<VariantResult> {
  let pipeline = sharp(sourceBuffer)
    .rotate()
    .resize({ width: targetWidth, withoutEnlargement: true, fit: "inside" });
  pipeline = hasAlpha ? pipeline.png({ compressionLevel: 9 }) : pipeline.webp({ quality: 82 });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  const ext = hasAlpha ? "png" : "webp";
  return {
    buffer: data,
    key: `${keyPrefix}/${variantName}.${ext}`,
    width: info.width,
    height: info.height,
    size: data.length,
  };
}

interface ProcessedImage {
  variants: { thumbnail: VariantResult; medium: VariantResult; optimized: VariantResult };
  width: number;
  height: number;
  mimeType: string;
  extension: string;
}

async function processImage(buffer: Buffer, keyPrefix: string): Promise<ProcessedImage> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(buffer, {
      limitInputPixels: DECOMPRESSION_BOMB_PIXEL_LIMIT,
      failOn: "error",
    }).metadata();
  } catch {
    throw new AppError("Image could not be read — it may be corrupt or too large", 400);
  }

  if (!metadata.width || !metadata.height) {
    throw new AppError("Unable to read image dimensions", 400);
  }

  let sourceBuffer = buffer;
  if (metadata.width > env.maxImageWidth || metadata.height > env.maxImageHeight) {
    sourceBuffer = await sharp(buffer)
      .rotate()
      .resize({
        width: env.maxImageWidth,
        height: env.maxImageHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer();
  }

  const hasAlpha = Boolean(metadata.hasAlpha);

  const [thumbnail, medium, optimized] = await Promise.all([
    makeVariant(sourceBuffer, keyPrefix, "thumbnail", env.imageThumbnailWidth, hasAlpha),
    makeVariant(sourceBuffer, keyPrefix, "medium", env.imageMediumWidth, hasAlpha),
    makeVariant(sourceBuffer, keyPrefix, "optimized", env.imageOptimizedWidth, hasAlpha),
  ]);

  return {
    variants: { thumbnail, medium, optimized },
    width: optimized.width,
    height: optimized.height,
    mimeType: hasAlpha ? "image/png" : "image/webp",
    extension: hasAlpha ? "png" : "webp",
  };
}

interface ProcessedPdf {
  pageCount?: number;
}

async function processPdf(buffer: Buffer): Promise<ProcessedPdf> {
  if (!looksLikeValidPdfStructure(buffer)) {
    throw new AppError("File does not look like a valid PDF", 400);
  }

  // Best-effort only — a PDF that fails page-count extraction is still a
  // valid, storable document; we just don't learn its page count.
  try {
    const parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo();
    await parser.destroy();
    const pageCount = typeof info.total === "number" ? info.total : undefined;
    if (pageCount !== undefined && pageCount > MAX_SANE_PDF_PAGE_COUNT) {
      throw new AppError("PDF page count is unreasonably large", 400);
    }
    return { pageCount };
  } catch (err) {
    if (err instanceof AppError) throw err;
    return {};
  }
}

export interface UploadedMediaItem {
  mediaId: string;
  mediaType: MediaType;
  url: string;
  thumbnailUrl?: string;
  mediumUrl?: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  pageCount?: number;
  status: MediaStatus;
  // True when this upload matched an existing asset by content hash and no
  // new file/record was created — the caller got back the pre-existing asset
  // (spec §17).
  deduped?: boolean;
}

export interface UploadError {
  originalName: string;
  message: string;
}

export interface UploadResult {
  succeeded: UploadedMediaItem[];
  errors: UploadError[];
}

function toUploadedItem(doc: MediaDocument, deduped = false): UploadedMediaItem {
  const base: UploadedMediaItem = {
    mediaId: doc._id.toString(),
    mediaType: doc.mediaType,
    url: storage.getUrl(doc.variants ? doc.variants.optimized.key : doc.storageKey),
    mimeType: doc.mimeType,
    size: doc.size,
    status: doc.status,
  };
  if (deduped) base.deduped = true;
  if (doc.width) base.width = doc.width;
  if (doc.height) base.height = doc.height;
  if (doc.pageCount !== undefined) base.pageCount = doc.pageCount;
  if (doc.variants) {
    base.thumbnailUrl = storage.getUrl(doc.variants.thumbnail.key);
    base.mediumUrl = storage.getUrl(doc.variants.medium.key);
  }
  return base;
}

async function processOneFile(
  file: Express.Multer.File,
  uploadedBy: string
): Promise<{ item?: UploadedMediaItem; error?: UploadError }> {
  const detected = detectFileType(file.buffer);
  if (!detected) {
    return {
      error: {
        originalName: file.originalname,
        message: "Unrecognized or unsupported file type",
      },
    };
  }

  const maxBytes =
    detected.mediaType === "IMAGE"
      ? env.maxImageFileSizeMb * 1024 * 1024
      : env.maxPdfFileSizeMb * 1024 * 1024;
  if (file.buffer.length > maxBytes) {
    const limitMb = detected.mediaType === "IMAGE" ? env.maxImageFileSizeMb : env.maxPdfFileSizeMb;
    return {
      error: {
        originalName: file.originalname,
        message: `File exceeds the maximum allowed size of ${limitMb}MB`,
      },
    };
  }

  const keyPrefix = storageKeyPrefix(detected.mediaType === "IMAGE" ? "images" : "documents");
  const writtenKeys: string[] = [];
  let createdDoc: MediaDocument | undefined;

  try {
    if (detected.mediaType === "IMAGE") {
      const processed = await processImage(file.buffer, keyPrefix);

      // Dedupe (spec §17): the hash is over the processed `optimized` bytes,
      // which are deterministic from the source — so re-uploading the same
      // file resolves to the asset already in the library instead of writing
      // another physical copy. Keyed on the optimized output (not the raw
      // upload) so the migration can backfill it from files already on disk.
      const contentHash = crypto
        .createHash("sha256")
        .update(processed.variants.optimized.buffer)
        .digest("hex");
      const existing = await Media.findOne({ mediaType: "IMAGE", contentHash }).exec();
      if (existing) {
        logMediaEvent("MEDIA_UPLOAD_SUCCESS", {
          actorId: uploadedBy,
          mediaId: existing._id.toString(),
          deduped: "true",
        });
        return { item: toUploadedItem(existing, true) };
      }

      for (const variant of Object.values(processed.variants)) {
        await storage.upload(variant.key, variant.buffer);
        writtenKeys.push(variant.key);
      }

      const doc = await Media.create({
        mediaType: "IMAGE",
        storageProvider: env.storageProvider,
        storageKey: keyPrefix,
        variants: {
          thumbnail: {
            key: processed.variants.thumbnail.key,
            width: processed.variants.thumbnail.width,
            height: processed.variants.thumbnail.height,
            size: processed.variants.thumbnail.size,
          },
          medium: {
            key: processed.variants.medium.key,
            width: processed.variants.medium.width,
            height: processed.variants.medium.height,
            size: processed.variants.medium.size,
          },
          optimized: {
            key: processed.variants.optimized.key,
            width: processed.variants.optimized.width,
            height: processed.variants.optimized.height,
            size: processed.variants.optimized.size,
          },
        },
        originalName: file.originalname,
        mimeType: processed.mimeType,
        extension: processed.extension,
        size: processed.variants.optimized.size,
        width: processed.width,
        height: processed.height,
        contentHash,
        status: "TEMPORARY",
        uploadedBy,
      });
      createdDoc = doc;

      logMediaEvent("MEDIA_UPLOAD_SUCCESS", { actorId: uploadedBy, mediaId: doc._id.toString() });
      return { item: toUploadedItem(doc) };
    }

    // DOCUMENT (PDF) — never touches Sharp, stored as a single file.
    const processed = await processPdf(file.buffer);
    const key = `${keyPrefix}/document.pdf`;
    await storage.upload(key, file.buffer);
    writtenKeys.push(key);

    const doc = await Media.create({
      mediaType: "DOCUMENT",
      storageProvider: env.storageProvider,
      storageKey: key,
      originalName: file.originalname,
      mimeType: "application/pdf",
      extension: "pdf",
      size: file.buffer.length,
      pageCount: processed.pageCount,
      status: "TEMPORARY",
      uploadedBy,
    });
    createdDoc = doc;

    logMediaEvent("MEDIA_UPLOAD_SUCCESS", { actorId: uploadedBy, mediaId: doc._id.toString() });
    return { item: toUploadedItem(doc) };
  } catch (err) {
    // Storage succeeded but something after it failed (processing, mapping
    // to a response, or DB) — clean up whatever was already written, and the
    // Mongo record if it was already created, so nothing orphaned is left
    // behind in either place, per spec §31.
    for (const key of writtenKeys) {
      try {
        await storage.delete(key);
      } catch {
        logMediaEvent("STORAGE_DELETE_FAILED", { actorId: uploadedBy, key });
      }
    }
    if (createdDoc) {
      await createdDoc.deleteOne().catch(() => {
        logMediaEvent("STORAGE_DELETE_FAILED", {
          actorId: uploadedBy,
          mediaId: createdDoc!._id.toString(),
        });
      });
    }
    const message = err instanceof AppError ? err.message : "Failed to process file";
    logMediaEvent("MEDIA_UPLOAD_FAILED", {
      actorId: uploadedBy,
      originalName: file.originalname,
      reason: message,
    });
    return { error: { originalName: file.originalname, message } };
  }
}

export async function uploadFiles(
  files: Express.Multer.File[],
  uploadedBy: string
): Promise<UploadResult> {
  const results = await Promise.all(files.map((file) => processOneFile(file, uploadedBy)));

  const succeeded: UploadedMediaItem[] = [];
  const errors: UploadError[] = [];
  for (const result of results) {
    if (result.item) succeeded.push(result.item);
    if (result.error) errors.push(result.error);
  }

  return { succeeded, errors };
}

// ---- List / detail / update / delete ----

const SORTABLE_FIELDS = ["createdAt", "size", "originalName"] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export interface MediaListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  status?: unknown;
  mediaType?: unknown;
  mimeType?: unknown;
  entityType?: unknown;
  minWidth?: unknown;
  maxWidth?: unknown;
  minHeight?: unknown;
  maxHeight?: unknown;
  sort?: unknown;
  order?: unknown;
}

function buildFilter(params: MediaListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ originalName: pattern }, { altText: pattern }];
  }
  if (params.status === "TEMPORARY" || params.status === "ATTACHED") {
    filter.status = params.status;
  }
  if (params.mediaType === "IMAGE" || params.mediaType === "DOCUMENT") {
    filter.mediaType = params.mediaType;
  }
  if (typeof params.mimeType === "string" && params.mimeType.trim()) {
    filter.mimeType = params.mimeType.trim();
  }
  if (typeof params.entityType === "string" && params.entityType.trim()) {
    filter.entityType = params.entityType.trim();
  }

  // Dimension-range filter (spec §6).
  const minWidth = toPositiveInt(params.minWidth);
  const maxWidth = toPositiveInt(params.maxWidth);
  const minHeight = toPositiveInt(params.minHeight);
  const maxHeight = toPositiveInt(params.maxHeight);
  if (minWidth || maxWidth) {
    filter.width = {
      ...(minWidth ? { $gte: minWidth } : {}),
      ...(maxWidth ? { $lte: maxWidth } : {}),
    };
  }
  if (minHeight || maxHeight) {
    filter.height = {
      ...(minHeight ? { $gte: minHeight } : {}),
      ...(maxHeight ? { $lte: maxHeight } : {}),
    };
  }

  return filter;
}

function baseListItem(doc: MediaDocument) {
  return {
    mediaId: doc._id.toString(),
    mediaType: doc.mediaType,
    url: storage.getUrl(doc.variants ? doc.variants.optimized.key : doc.storageKey),
    thumbnailUrl: doc.variants ? storage.getUrl(doc.variants.thumbnail.key) : undefined,
    mediumUrl: doc.variants ? storage.getUrl(doc.variants.medium.key) : undefined,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    size: doc.size,
    width: doc.width,
    height: doc.height,
    pageCount: doc.pageCount,
    altText: doc.altText ?? null,
    isPrimary: doc.isPrimary,
    sortOrder: doc.sortOrder,
    status: doc.status,
    entityType: doc.entityType ?? null,
    entityId: doc.entityId ? doc.entityId.toString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

// One aggregate for a whole page of results — how many entities currently
// reference each asset, so the library can show "used in N places" and the
// delete button knows whether it will be blocked before the click.
async function usageCountMap(mediaIds: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (mediaIds.length === 0) return new Map();
  const rows = await MediaUsage.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { mediaId: { $in: mediaIds } } },
    { $group: { _id: "$mediaId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
}

export async function getMediaList(params: MediaListParams) {
  const { page, pageSize, sort, order } = params;
  const field: SortableField =
    typeof sort === "string" && (SORTABLE_FIELDS as readonly string[]).includes(sort)
      ? (sort as SortableField)
      : "createdAt";
  const direction: 1 | -1 = order === "asc" ? 1 : -1;
  const filter = buildFilter(params);

  const [docs, total] = await Promise.all([
    Media.find(filter)
      .sort({ [field]: direction })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .exec(),
    Media.countDocuments(filter),
  ]);

  const counts = await usageCountMap(docs.map((d) => d._id));

  return {
    items: docs.map((doc) => ({
      ...baseListItem(doc),
      usageCount: counts.get(doc._id.toString()) ?? 0,
    })),
    page,
    pageSize,
    total,
    sort: field,
    order: direction === 1 ? "asc" : "desc",
  };
}

export async function getMediaById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Media.findById(id).exec();
  if (!doc) return null;
  const counts = await usageCountMap([doc._id]);
  return { ...baseListItem(doc), usageCount: counts.get(doc._id.toString()) ?? 0 };
}

export async function updateMediaById(id: string, patch: UpdateMediaBody) {
  if (!isValidObjectId(id)) return null;
  const doc = await Media.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" }).exec();
  if (!doc) return null;
  const counts = await usageCountMap([doc._id]);
  return { ...baseListItem(doc), usageCount: counts.get(doc._id.toString()) ?? 0 };
}

export async function deleteMediaById(id: string, actorId: string): Promise<boolean | null> {
  if (!isValidObjectId(id)) return null;
  const doc = await Media.findById(id).exec();
  if (!doc) return null;

  // Reference-safety (spec §10): never pull a file out from under an entity
  // that still points at it. The caller must detach every usage first.
  const usages = await getMediaUsages(id);
  if (usages.length > 0) {
    const n = usages.length;
    throw new AppError(
      `This image is used in ${n} place${n === 1 ? "" : "s"} and can't be permanently deleted until those references are removed.`,
      409,
      true,
      { usageCount: n, usages }
    );
  }

  const keys = doc.variants
    ? [doc.variants.thumbnail.key, doc.variants.medium.key, doc.variants.optimized.key]
    : [doc.storageKey];

  try {
    for (const key of keys) {
      await storage.delete(key);
    }
  } catch (err) {
    logMediaEvent("STORAGE_DELETE_FAILED", {
      actorId,
      mediaId: id,
      reason: err instanceof Error ? err.message : "unknown error",
    });
    // Don't pretend deletion succeeded — the Mongo record stays so the
    // system remains recoverable and the failure isn't silently lost.
    throw new AppError("Failed to delete stored file(s). Please try again.", 500);
  }

  await doc.deleteOne();
  logMediaEvent("MEDIA_DELETED", { actorId, mediaId: id });
  return true;
}

// ---- Cross-module reference primitives ----
// A Media doc is now a pure asset. Which entities USE it lives in the
// MediaUsage collection — one row per (asset, entity, field) — so one
// physical file can be referenced by many products / blogs / categories
// without being copied (spec §4). Media.status is a denormalised cache of
// "has ≥1 usage row", kept in sync here so the list filter and the cleanup
// job stay index-only.
// Generic on purpose — Media doesn't know what an "IMAGE-only" rule means to
// a particular entity type; that's the calling module's rule to enforce
// before calling attach (see category.service.ts).

export async function getMediaDocById(id: string): Promise<MediaDocument | null> {
  if (!isValidObjectId(id)) return null;
  return Media.findById(id).exec();
}

async function recomputeMediaStatus(mediaId: string): Promise<void> {
  const stillUsed = await MediaUsage.exists({ mediaId });
  await Media.updateOne(
    { _id: mediaId },
    { $set: { status: stillUsed ? "ATTACHED" : "TEMPORARY" } }
  );
}

export interface AttachMediaOptions {
  field: MediaUsageField;
  sortOrder?: number;
  isPrimary?: boolean;
  /** Context-specific alt text — stored on the usage row, not the asset. */
  altText?: string | null;
}

// Idempotent upsert of a single (asset → entity → field) reference. Calling
// it again for the same slot just updates ordering / primary / alt. Unlike
// the old single-owner version this NEVER rejects an asset that is already
// used elsewhere — reuse is the point.
export async function attachMediaToEntity(
  mediaId: string,
  entityType: MediaEntityType,
  entityId: string,
  opts: AttachMediaOptions
): Promise<MediaDocument> {
  const doc = await getMediaDocById(mediaId);
  if (!doc) {
    throw new AppError("Media not found", 404);
  }

  const set: Record<string, unknown> = { field: opts.field };
  if (opts.sortOrder !== undefined) set.sortOrder = opts.sortOrder;
  if (opts.isPrimary !== undefined) set.isPrimary = opts.isPrimary;
  if (opts.altText !== undefined) {
    set.altText = opts.altText === null ? undefined : opts.altText;
  }

  await MediaUsage.updateOne(
    { mediaId, entityType, entityId, field: opts.field },
    { $set: set, $setOnInsert: { mediaId, entityType, entityId } },
    { upsert: true }
  );

  if (doc.status !== "ATTACHED") {
    doc.status = "ATTACHED";
    await doc.save();
  }
  return doc;
}

export interface DetachScope {
  entityType?: MediaEntityType;
  entityId?: string;
  field?: MediaUsageField;
}

// Removes reference rows, not the asset. With no scope it removes EVERY
// usage of the asset (the "this entity is being hard-deleted, drop all of
// its media links" path). With a scope it removes only the matching
// (entity[/field]) rows, leaving the asset attached wherever else it's
// used. The asset itself is kept and reverts to TEMPORARY once its last
// usage goes — the TTL cleanup job reclaims it later if nothing re-attaches.
// Safe to call with an id that no longer exists.
export async function detachMedia(
  mediaId: string | undefined | null,
  scope?: DetachScope
): Promise<void> {
  if (!mediaId || !isValidObjectId(mediaId)) return;

  const filter: Record<string, unknown> = { mediaId };
  if (scope?.entityType) filter.entityType = scope.entityType;
  if (scope?.entityId) filter.entityId = scope.entityId;
  if (scope?.field) filter.field = scope.field;

  await MediaUsage.deleteMany(filter);
  await recomputeMediaStatus(mediaId);
}

// ---- "Where is this used" ----

export interface MediaUsageInfo {
  entityType: MediaEntityType;
  entityId: string;
  field: MediaUsageField;
  label: string;
}

const USAGE_LABEL_LOADERS: Partial<
  Record<MediaEntityType, (ids: string[]) => Promise<Map<string, string>>>
> = {
  PRODUCT: (ids) => labelMap(Product, ids, "name"),
  CATEGORY: (ids) => labelMap(Category, ids, "name"),
  BRAND: (ids) => labelMap(Brand, ids, "name"),
  COLLECTION: (ids) => labelMap(Collection, ids, "name"),
  BLOG: (ids) => labelMap(Blog, ids, "title"),
  BLOG_CATEGORY: (ids) => labelMap(BlogCategory, ids, "name"),
};

async function labelMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model: any,
  ids: string[],
  labelField: string
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const docs = await Model.find({ _id: { $in: ids } })
    .select(labelField)
    .lean()
    .exec();
  return new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docs.map((d: any) => [String(d._id), String(d[labelField] ?? "")])
  );
}

export async function getMediaUsages(mediaId: string): Promise<MediaUsageInfo[]> {
  if (!isValidObjectId(mediaId)) return [];
  const rows = await MediaUsage.find({ mediaId })
    .sort({ entityType: 1, createdAt: 1 })
    .lean()
    .exec();
  if (rows.length === 0) return [];

  // Resolve display labels in one query per entity type.
  const byType = new Map<MediaEntityType, string[]>();
  for (const row of rows) {
    const list = byType.get(row.entityType) ?? [];
    list.push(String(row.entityId));
    byType.set(row.entityType, list);
  }
  const labels = new Map<string, string>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const loader = USAGE_LABEL_LOADERS[type];
      if (!loader) return;
      const map = await loader(ids);
      for (const [id, label] of map) labels.set(`${type}:${id}`, label);
    })
  );

  return rows.map((row) => {
    const entityId = String(row.entityId);
    return {
      entityType: row.entityType,
      entityId,
      field: row.field,
      label: labels.get(`${row.entityType}:${entityId}`) || `${row.entityType} ${entityId}`,
    };
  });
}

export async function countMediaUsages(mediaId: string): Promise<number> {
  if (!isValidObjectId(mediaId)) return 0;
  return MediaUsage.countDocuments({ mediaId });
}
