import { Schema, model, Document, Types } from "mongoose";

export const MEDIA_TYPES = ["IMAGE", "DOCUMENT"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEDIA_STATUSES = ["TEMPORARY", "ATTACHED"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const MEDIA_ENTITY_TYPES = [
  "PRODUCT",
  "CATEGORY",
  "BRAND",
  "COLLECTION",
  "BANNER",
  "USER",
  "REVIEW",
  "BLOG",
  "BLOG_CATEGORY",
] as const;
export type MediaEntityType = (typeof MEDIA_ENTITY_TYPES)[number];

export interface MediaVariant {
  key: string;
  width: number;
  height: number;
  size: number;
}

export interface MediaDocument extends Document {
  mediaType: MediaType;

  entityType?: MediaEntityType;
  entityId?: Types.ObjectId;

  storageProvider: string;
  storageKey: string;
  variants?: {
    thumbnail: MediaVariant;
    medium: MediaVariant;
    optimized: MediaVariant;
  };

  originalName: string;
  mimeType: string;
  extension: string;

  size: number;

  width?: number;
  height?: number;

  pageCount?: number;

  altText?: string;

  isPrimary: boolean;
  sortOrder: number;

  status: MediaStatus;

  uploadedBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const MediaVariantSchema = new Schema<MediaVariant>(
  {
    key: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

// A separate Schema (rather than an inline nested-object literal) with an
// explicit `default: undefined` — otherwise Mongoose auto-vivifies `variants`
// as `{}` on every document, including PDFs that never set it, which breaks
// every `doc.variants ? ... : ...` check used to tell IMAGE from DOCUMENT.
const MediaVariantsSchema = new Schema(
  {
    thumbnail: { type: MediaVariantSchema, required: true },
    medium: { type: MediaVariantSchema, required: true },
    optimized: { type: MediaVariantSchema, required: true },
  },
  { _id: false }
);

const MediaSchema = new Schema<MediaDocument>(
  {
    mediaType: { type: String, enum: MEDIA_TYPES, required: true },

    entityType: { type: String, enum: MEDIA_ENTITY_TYPES },
    entityId: { type: Schema.Types.ObjectId },

    storageProvider: { type: String, required: true },
    storageKey: { type: String, required: true, unique: true },
    variants: { type: MediaVariantsSchema, default: undefined },

    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    extension: { type: String, required: true },

    size: { type: Number, required: true },

    width: { type: Number },
    height: { type: Number },

    pageCount: { type: Number },

    altText: { type: String },

    isPrimary: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },

    status: { type: String, enum: MEDIA_STATUSES, default: "TEMPORARY" },

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

MediaSchema.index({ status: 1, createdAt: 1 });
MediaSchema.index({ entityType: 1, entityId: 1 });
MediaSchema.index({ mediaType: 1, createdAt: 1 });

export const Media = model<MediaDocument>("Media", MediaSchema);
