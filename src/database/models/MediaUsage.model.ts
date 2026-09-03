import { Schema, model, Document, Types } from "mongoose";
import { MEDIA_ENTITY_TYPES, MediaEntityType } from "./Media.model";

// A single reference from an entity to a shared Media asset. This is what
// makes one physical file reusable across many products / blogs / categories:
// the Media doc is now a pure asset record, and every place that "uses" it
// gets its own MediaUsage row. Per-usage presentation state (ordering, which
// one is primary, a context-specific alt text) lives HERE, not on Media —
// two products can order the same asset differently.
//
// Replaces the old single-owner model where Media.entityType / Media.entityId
// pointed at exactly one entity and attachMediaToEntity() rejected a second
// owner with a 409.

export const MEDIA_USAGE_FIELDS = [
  "gallery", // product images
  "image", // category / collection image
  "logo", // brand logo
  "featured", // blog featured image
  "thumbnail", // blog list thumbnail
  "og", // blog / page social-share image
  "body", // inline image inside rich-text body
  "banner",
] as const;
export type MediaUsageField = (typeof MEDIA_USAGE_FIELDS)[number];

export interface MediaUsageDocument extends Document {
  mediaId: Types.ObjectId;
  entityType: MediaEntityType;
  entityId: Types.ObjectId;
  field: MediaUsageField;
  sortOrder: number;
  isPrimary: boolean;
  // Context-specific override. The public read paths resolve
  // `usage.altText ?? media.altText`, so editing this here never rewrites the
  // asset's own alt text everywhere else it's used (spec §8).
  altText?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MediaUsageSchema = new Schema<MediaUsageDocument>(
  {
    mediaId: { type: Schema.Types.ObjectId, ref: "Media", required: true },
    entityType: { type: String, enum: MEDIA_ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    field: { type: String, enum: MEDIA_USAGE_FIELDS, required: true },
    sortOrder: { type: Number, default: 0, min: 0 },
    isPrimary: { type: Boolean, default: false },
    altText: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// Reference-count / "where is this used" lookups for the delete guard and the
// preview panel.
MediaUsageSchema.index({ mediaId: 1 });
// The per-entity read (e.g. all of a product's gallery images, ordered).
MediaUsageSchema.index({ entityType: 1, entityId: 1, sortOrder: 1 });
// One row per (asset, entity, field) — re-attaching the same asset to the
// same slot is an idempotent upsert, not a duplicate.
MediaUsageSchema.index(
  { mediaId: 1, entityType: 1, entityId: 1, field: 1 },
  { unique: true }
);

export const MediaUsage = model<MediaUsageDocument>("MediaUsage", MediaUsageSchema);
