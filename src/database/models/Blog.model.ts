import { Schema, model, Document, Types } from "mongoose";

// A Blog is long-form editorial content with its own publishing lifecycle and
// a dedicated SEO surface. It follows Product's conventions deliberately: an
// embedded `seo` sub-schema (see ProductSeoSchema), a `status` enum with an
// explicit transition table, and createdBy/updatedBy audit refs.
//
// Images are NOT stored as URLs here. Body images are Media docs attached via
// entityType "BLOG" (same many-to-one attachment the Media module already
// provides), and the three "singleton" images — featured, thumbnail, OG —
// are Media refs by id (same shape as Collection.imageMediaId). The rendered
// URL is derived at read time in blog.service.ts.

export const BLOG_STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

// Single source of truth for a legal status change, shared by the admin
// status endpoint, the publish/unpublish/archive shortcuts, the bulk-action
// handler, and the scheduled-publish cron. Anything not listed is a 400.
// "Unpublish" is PUBLISHED -> DRAFT; SCHEDULED -> DRAFT cancels a schedule.
export const BLOG_STATUS_TRANSITIONS: Record<BlogStatus, BlogStatus[]> = {
  DRAFT: ["SCHEDULED", "PUBLISHED", "ARCHIVED"],
  SCHEDULED: ["PUBLISHED", "DRAFT", "ARCHIVED"],
  PUBLISHED: ["DRAFT", "ARCHIVED"],
  ARCHIVED: ["DRAFT"],
};

export interface BlogSeo {
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  canonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageMediaId?: Types.ObjectId;
  noIndex: boolean;
  noFollow: boolean;
}

export interface BlogFaq {
  question: string;
  answer: string;
}

export interface BlogTocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface BlogStatusHistoryEntry {
  status: BlogStatus;
  at: Date;
  byUserId?: Types.ObjectId;
  note?: string;
}

export interface BlogDocument extends Document {
  title: string;
  slug: string;
  // Every slug this post has previously been published under. Kept so the
  // public detail route can 308-redirect an old URL to the current one
  // instead of 404ing established inbound links.
  previousSlugs: string[];
  excerpt: string;

  // Sanitized HTML (see blog.sanitize.ts) with stable heading ids injected.
  contentHtml: string;
  // Tag-stripped plaintext of contentHtml — powers $text search and the
  // reading-time estimate without re-parsing HTML on every read.
  contentText: string;

  featuredImageMediaId?: Types.ObjectId;
  thumbnailImageMediaId?: Types.ObjectId;

  author?: Types.ObjectId;
  authorName?: string;
  categoryId: Types.ObjectId;
  tagIds: Types.ObjectId[];

  status: BlogStatus;
  publishedAt?: Date;
  scheduledFor?: Date;
  statusHistory: BlogStatusHistoryEntry[];

  seo: BlogSeo;

  readingTimeMinutes: number;
  tableOfContents: BlogTocItem[];
  schemaEnabled: boolean;

  // Denormalized SEO-checklist outcome, recomputed on every write (see
  // blog.seo.ts). Stored so the admin list can filter/sort/badge by SEO
  // readiness without pulling every post's full body to re-run the checks.
  seoReadiness: "good" | "needs-work" | "poor";
  seoScore: number;

  faqs: BlogFaq[];
  // Manual "you might also like" override. Empty => blog.service.ts computes
  // related posts (same category -> shared tags -> recent).
  relatedBlogIds: Types.ObjectId[];

  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  publishedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const BlogSeoSchema = new Schema<BlogSeo>(
  {
    metaTitle: { type: String, trim: true, maxlength: 70 },
    metaDescription: { type: String, trim: true, maxlength: 200 },
    focusKeyword: { type: String, trim: true, maxlength: 120 },
    canonicalUrl: { type: String, trim: true, maxlength: 500 },
    ogTitle: { type: String, trim: true, maxlength: 120 },
    ogDescription: { type: String, trim: true, maxlength: 200 },
    ogImageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    noIndex: { type: Boolean, default: false },
    noFollow: { type: Boolean, default: false },
  },
  { _id: false }
);

const BlogFaqSchema = new Schema<BlogFaq>(
  {
    question: { type: String, required: true, trim: true, maxlength: 300 },
    answer: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { _id: false }
);

const BlogTocItemSchema = new Schema<BlogTocItem>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    level: { type: Number, enum: [2, 3], required: true },
  },
  { _id: false }
);

const BlogStatusHistorySchema = new Schema<BlogStatusHistoryEntry>(
  {
    status: { type: String, enum: BLOG_STATUSES, required: true },
    at: { type: Date, required: true },
    byUserId: { type: Schema.Types.ObjectId, ref: "User" },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

const BlogSchema = new Schema<BlogDocument>(
  {
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
    slug: { type: String, required: true, trim: true, unique: true, maxlength: 220 },
    previousSlugs: { type: [String], default: [] },
    excerpt: { type: String, required: true, trim: true, maxlength: 320 },

    contentHtml: { type: String, default: "", maxlength: 200000 },
    contentText: { type: String, default: "" },

    featuredImageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    thumbnailImageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },

    author: { type: Schema.Types.ObjectId, ref: "User" },
    authorName: { type: String, trim: true, maxlength: 120 },
    categoryId: { type: Schema.Types.ObjectId, ref: "BlogCategory", required: true },
    tagIds: { type: [Schema.Types.ObjectId], ref: "BlogTag", default: [] },

    status: { type: String, enum: BLOG_STATUSES, default: "DRAFT" },
    publishedAt: { type: Date },
    scheduledFor: { type: Date },
    statusHistory: { type: [BlogStatusHistorySchema], default: [] },

    seo: { type: BlogSeoSchema, default: () => ({ noIndex: false, noFollow: false }) },

    readingTimeMinutes: { type: Number, default: 0, min: 0 },
    tableOfContents: { type: [BlogTocItemSchema], default: [] },
    schemaEnabled: { type: Boolean, default: true },

    seoReadiness: { type: String, enum: ["good", "needs-work", "poor"], default: "poor" },
    seoScore: { type: Number, default: 0, min: 0, max: 100 },

    faqs: { type: [BlogFaqSchema], default: [] },
    relatedBlogIds: { type: [Schema.Types.ObjectId], ref: "Blog", default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// `slug` already carries `unique: true` on the field definition above.
BlogSchema.index({ previousSlugs: 1 });
// Public listing: "published, not scheduled-in-the-future, newest first".
BlogSchema.index({ status: 1, publishedAt: -1 });
// Scheduled-publish cron: "SCHEDULED with scheduledFor in the past".
BlogSchema.index({ status: 1, scheduledFor: 1 });
BlogSchema.index({ categoryId: 1, status: 1, publishedAt: -1 });
BlogSchema.index({ tagIds: 1, status: 1 });
BlogSchema.index({ author: 1, status: 1 });
BlogSchema.index({ seoReadiness: 1 });
BlogSchema.index({ createdAt: -1 });
BlogSchema.index({ updatedAt: -1 });
// Admin + public keyword search.
BlogSchema.index({ title: "text", excerpt: "text", contentText: "text" });

export const Blog = model<BlogDocument>("Blog", BlogSchema);
