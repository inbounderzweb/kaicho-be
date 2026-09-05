import { env } from "../../config/env";
import { Media, MediaUsage } from "../../database/models";
import { getStorageProvider } from "./storage";
import { logMediaEvent } from "./mediaLogger";

const storage = getStorageProvider();

// Abandoned uploads: TEMPORARY media that never got attached to anything
// within the TTL window. Deletes the physical file(s) first, then the
// record — if a given item's file deletion fails, it's skipped (left for
// the next run) rather than silently losing the DB record for a file that
// might still be on disk.
export async function cleanupExpiredTemporaryMedia(): Promise<{
  deleted: number;
  failed: number;
}> {
  const cutoff = new Date(Date.now() - env.mediaTemporaryTtlHours * 60 * 60 * 1000);
  const expired = await Media.find({ status: "TEMPORARY", createdAt: { $lt: cutoff } }).exec();

  let deleted = 0;
  let failed = 0;

  for (const doc of expired) {
    // Defensive: never reclaim an asset something still references, even if
    // its denormalised status somehow lagged behind (spec §10).
    const stillReferenced = await MediaUsage.exists({ mediaId: doc._id });
    if (stillReferenced) {
      await Media.updateOne({ _id: doc._id }, { $set: { status: "ATTACHED" } });
      continue;
    }

    const keys = doc.variants
      ? [doc.variants.thumbnail.key, doc.variants.medium.key, doc.variants.optimized.key]
      : [doc.storageKey];

    try {
      for (const key of keys) {
        await storage.delete(key);
      }
      await doc.deleteOne();
      deleted += 1;
    } catch (err) {
      failed += 1;
      logMediaEvent("STORAGE_DELETE_FAILED", {
        mediaId: doc._id.toString(),
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  if (deleted > 0 || failed > 0) {
    logMediaEvent("MEDIA_CLEANUP", { deleted, failed });
  }

  return { deleted, failed };
}
