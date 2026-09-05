/**
 * One-off migration for the media-reference model.
 *
 * 1. Seeds a MediaUsage row for every Media doc that still carries the legacy
 *    single-owner entityType/entityId pointer, so existing products / blogs /
 *    categories keep their images and the delete guard + cleanup job see the
 *    reference.
 * 2. Backfills Media.contentHash (sha256 of the stored `optimized` variant)
 *    for existing images so re-uploading one of them dedupes (spec §17).
 *
 * Idempotent — safe to run more than once. Run after deploying the schema:
 *   npx ts-node-dev --transpile-only src/scripts/backfill-media.ts
 *   (or: node dist/scripts/backfill-media.js)
 */
import crypto from "crypto";
import mongoose from "mongoose";
import { env } from "../config/env";
import { Media, MediaUsage, MediaEntityType } from "../database/models";
import { MediaUsageField } from "../database/models/MediaUsage.model";
import { getStorageProvider } from "../modules/media/storage";

const storage = getStorageProvider();

// Which usage "slot" a legacy pointer maps to. BLOG lumps featured/thumbnail/
// OG/body together as one reference bucket (see blog.media.ts).
const FIELD_BY_ENTITY: Record<MediaEntityType, MediaUsageField> = {
  PRODUCT: "gallery",
  CATEGORY: "image",
  BRAND: "logo",
  COLLECTION: "image",
  BANNER: "banner",
  USER: "image",
  REVIEW: "image",
  BLOG: "body",
  BLOG_CATEGORY: "image",
};

async function seedUsages(): Promise<void> {
  const cursor = Media.find({
    entityType: { $exists: true, $ne: null },
    entityId: { $exists: true, $ne: null },
  }).cursor();

  let created = 0;
  let skipped = 0;
  for await (const doc of cursor) {
    const entityType = doc.entityType as MediaEntityType;
    const entityId = doc.entityId!;
    const field = FIELD_BY_ENTITY[entityType] ?? "image";

    const exists = await MediaUsage.exists({ mediaId: doc._id, entityType, entityId, field });
    if (exists) {
      skipped += 1;
      continue;
    }
    await MediaUsage.create({
      mediaId: doc._id,
      entityType,
      entityId,
      field,
      isPrimary: doc.isPrimary ?? false,
      sortOrder: doc.sortOrder ?? 0,
    });
    created += 1;
  }
  console.log(`  usages: created ${created}, already present ${skipped}`);
}

async function backfillHashes(): Promise<void> {
  const cursor = Media.find({
    mediaType: "IMAGE",
    $or: [{ contentHash: { $exists: false } }, { contentHash: null }],
  }).cursor();

  let hashed = 0;
  let unreadable = 0;
  for await (const doc of cursor) {
    const key = doc.variants ? doc.variants.optimized.key : doc.storageKey;
    try {
      const buf = await storage.read(key);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      await Media.updateOne({ _id: doc._id }, { $set: { contentHash: hash } });
      hashed += 1;
    } catch (err) {
      unreadable += 1;
      console.warn(`  ! could not hash ${doc._id.toString()} (${key}): ${(err as Error).message}`);
    }
  }
  console.log(`  hashes: set ${hashed}, unreadable ${unreadable}`);
}

async function main() {
  await mongoose.connect(env.mongoUri);
  console.log("Connected. Backfilling media reference model…");
  await seedUsages();
  await backfillHashes();
  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
