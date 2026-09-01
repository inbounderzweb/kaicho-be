import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Media, MediaDocument, MediaEntityType } from "../../database/models";
import { getMediaDocById, attachMediaToEntity, detachMedia } from "../media/media.service";
import { getStorageProvider } from "../media/media.storage";

const storage = getStorageProvider();

export interface BlogImage {
  mediaId: string;
  url: string;
  mediumUrl?: string;
  thumbnailUrl?: string;
  altText: string | null;
}

export function toBlogImage(media: MediaDocument | null | undefined): BlogImage | null {
  if (!media) return null;
  const optimizedKey = media.variants ? media.variants.optimized.key : media.storageKey;
  return {
    mediaId: media._id.toString(),
    url: storage.getUrl(optimizedKey),
    mediumUrl: media.variants ? storage.getUrl(media.variants.medium.key) : undefined,
    thumbnailUrl: media.variants ? storage.getUrl(media.variants.thumbnail.key) : undefined,
    altText: media.altText ?? null,
  };
}

export async function resolveBlogImage(mediaId?: mongoose.Types.ObjectId | string | null): Promise<BlogImage | null> {
  if (!mediaId) return null;
  const media = await getMediaDocById(mediaId.toString());
  return toBlogImage(media);
}

/** Bulk variant of resolveBlogImage — one query for a list view. */
export async function resolveBlogImages(
  ids: (mongoose.Types.ObjectId | string | undefined | null)[]
): Promise<Map<string, BlogImage>> {
  const unique = [...new Set(ids.filter(Boolean).map((v) => v!.toString()))];
  if (unique.length === 0) return new Map();
  const docs = await Media.find({ _id: { $in: unique } }).exec();
  const map = new Map<string, BlogImage>();
  for (const doc of docs) {
    const img = toBlogImage(doc);
    if (img) map.set(doc._id.toString(), img);
  }
  return map;
}

/** Body <img data-media-id="…"> markers, so those uploads follow the same
 *  attach/detach lifecycle as the featured image. */
export function extractBodyMediaIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /data-media-id=["']([a-f0-9]{24})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1].toLowerCase());
  return [...ids];
}

export async function assertImageMedia(mediaId: string): Promise<void> {
  if (!mongoose.isValidObjectId(mediaId)) throw new AppError("Invalid media", 400);
  const media = await getMediaDocById(mediaId);
  if (!media) throw new AppError("Referenced image was not found", 400);
  if (media.mediaType !== "IMAGE") throw new AppError("Referenced media is not an image", 400);
}

/**
 * Reconcile which Media docs are attached to a blog (or blog category). Attach
 * anything newly referenced, detach anything no longer referenced. Mirrors the
 * attach/detach dance in category.service.ts, generalised to a set of ids
 * (featured + thumbnail + OG + every body image).
 */
export async function syncEntityMedia(params: {
  entityType: MediaEntityType;
  entityId: string;
  nextIds: string[];
  prevIds: string[];
}): Promise<void> {
  const next = new Set(params.nextIds.filter(Boolean).map((v) => v.toLowerCase()));
  const prev = new Set(params.prevIds.filter(Boolean).map((v) => v.toLowerCase()));

  for (const id of next) {
    if (!prev.has(id)) await attachMediaToEntity(id, params.entityType, params.entityId);
  }
  for (const id of prev) {
    if (!next.has(id)) await detachMedia(id);
  }
}

/** Detach everything a blog owns — used on hard delete. */
export async function detachAllEntityMedia(entityType: MediaEntityType, entityId: string): Promise<void> {
  const docs = await Media.find({ entityType, entityId }).select("_id").lean();
  for (const doc of docs) await detachMedia(doc._id.toString());
}
