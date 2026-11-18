import { Schema, model, Document, Types } from "mongoose";

// Page-level SEO + editable HTML + FAQ for one page or one entity.
//
// Static pages (HOME, ABOUT, ...) have entityId = null. CATEGORY rows point at
// a Category. PRODUCT rows hold only htmlContent + faq: a product's SEO fields
// already live on Product.seo and stay there (no second copy) — the seoContent
// service reads/writes them through the Product document.

export const STATIC_PAGE_TYPES = ["HOME", "ABOUT", "CONTACT", "ALL_PRODUCTS", "B2B"] as const;
export const ENTITY_PAGE_TYPES = ["PRODUCT", "CATEGORY"] as const;
export const PAGE_TYPES = [...STATIC_PAGE_TYPES, ...ENTITY_PAGE_TYPES] as const;
export type StaticPageType = (typeof STATIC_PAGE_TYPES)[number];
export type EntityPageType = (typeof ENTITY_PAGE_TYPES)[number];
export type PageType = (typeof PAGE_TYPES)[number];

export interface PageSeo {
  title: string;
  description: string;
  keywords: string[];
  canonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageMediaId?: Types.ObjectId;
  robotsIndex: boolean;
  robotsFollow: boolean;
}

export interface PageFaqItem {
  _id: Types.ObjectId;
  question: string;
  answer: string; // sanitized HTML
}

export interface PageContentDocument extends Document {
  pageType: PageType;
  entityId?: Types.ObjectId;
  seo: PageSeo;
  htmlContent: string; // sanitized HTML
  faqEnabled: boolean;
  faqs: PageFaqItem[]; // array order IS the display order
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PageSeoSchema = new Schema<PageSeo>(
  {
    title: { type: String, trim: true, maxlength: 70, default: "" },
    description: { type: String, trim: true, maxlength: 200, default: "" },
    keywords: { type: [String], default: [] },
    canonicalUrl: { type: String, trim: true, maxlength: 500 },
    ogTitle: { type: String, trim: true, maxlength: 70 },
    ogDescription: { type: String, trim: true, maxlength: 200 },
    ogImageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    robotsIndex: { type: Boolean, default: true },
    robotsFollow: { type: Boolean, default: true },
  },
  { _id: false }
);

const PageFaqSchema = new Schema<PageFaqItem>({
  question: { type: String, required: true, trim: true, maxlength: 300 },
  answer: { type: String, required: true, maxlength: 5000 },
});

const PageContentSchema = new Schema<PageContentDocument>(
  {
    pageType: { type: String, enum: PAGE_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId },
    seo: { type: PageSeoSchema, default: () => ({}) },
    htmlContent: { type: String, default: "", maxlength: 50000 },
    faqEnabled: { type: Boolean, default: false },
    faqs: { type: [PageFaqSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// One document per static page, one per entity. For static pages entityId is
// absent, so the compound key is (pageType, null) — still unique per page.
PageContentSchema.index({ pageType: 1, entityId: 1 }, { unique: true });

export const PageContent = model<PageContentDocument>("PageContent", PageContentSchema);
