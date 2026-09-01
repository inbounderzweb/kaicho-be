import { Schema, model, Document } from "mongoose";

// Lightweight, flat labels for content discovery. Tags are created on demand
// from the blog editor (type-to-search, create-on-enter) and de-duplicated by
// slug. Deliberately minimal — no description/image/SEO fields — because tag
// archive pages are only exposed when they carry genuine editorial value
// (spec §14), not one-per-tag by default.

export interface BlogTagDocument extends Document {
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

const BlogTagSchema = new Schema<BlogTagDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, trim: true, maxlength: 80, unique: true },
  },
  { timestamps: true }
);

// `slug` already carries `unique: true` on the field definition above.
BlogTagSchema.index({ name: "text" });

export const BlogTag = model<BlogTagDocument>("BlogTag", BlogTagSchema);
