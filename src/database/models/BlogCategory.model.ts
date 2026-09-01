import { Schema, model, Document, Types } from "mongoose";

// The taxonomy for blog posts, kept separate from the product Category tree
// (different URL space /blog/category/:slug, different lifecycle, no nesting).
// Shape mirrors Category.model.ts minus parentId, plus its own meta title/
// description for the category archive page.

export const BLOG_CATEGORY_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type BlogCategoryStatus = (typeof BLOG_CATEGORY_STATUSES)[number];

export interface BlogCategoryDocument extends Document {
  name: string;
  slug: string;
  description?: string;
  imageMediaId?: Types.ObjectId;
  metaTitle?: string;
  metaDescription?: string;
  status: BlogCategoryStatus;
  createdAt: Date;
  updatedAt: Date;
}

const BlogCategorySchema = new Schema<BlogCategoryDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, unique: true },
    slug: { type: String, required: true, trim: true, maxlength: 140, unique: true },
    description: { type: String, trim: true, maxlength: 2000 },
    imageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    metaTitle: { type: String, trim: true, maxlength: 70 },
    metaDescription: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: BLOG_CATEGORY_STATUSES, default: "ACTIVE" },
  },
  { timestamps: true }
);

// `slug` and `name` already carry `unique: true` on their field definitions.
BlogCategorySchema.index({ status: 1 });

export const BlogCategory = model<BlogCategoryDocument>("BlogCategory", BlogCategorySchema);
