import { z } from "zod";
import { PAGE_TYPES, STATIC_PAGE_TYPES, ENTITY_PAGE_TYPES } from "../../database/models";

export const staticPageTypeSchema = z.enum(STATIC_PAGE_TYPES);
export const entityPageTypeSchema = z.enum(ENTITY_PAGE_TYPES);
export const anyPageTypeSchema = z.enum(PAGE_TYPES);

const keywordsSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(20, "A maximum of 20 SEO keywords is allowed");

// Canonical may be site-relative ("/products") or absolute http(s) — never a
// javascript:/data: URL.
const canonicalSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || v.startsWith("/") || /^https?:\/\//i.test(v), {
    message: "Canonical URL must start with / or http(s)://",
  });

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid media id");

export const seoFieldsSchema = z.strictObject({
  title: z.string().trim().max(70, "SEO title is too long (max 70)").default(""),
  description: z.string().trim().max(200, "SEO description is too long (max 200)").default(""),
  keywords: keywordsSchema.default([]),
  canonicalUrl: canonicalSchema.optional(),
  ogTitle: z.string().trim().max(70).optional(),
  ogDescription: z.string().trim().max(200).optional(),
  ogImageMediaId: z.union([objectIdSchema, z.literal(""), z.null()]).optional(),
  robotsIndex: z.boolean().default(true),
  robotsFollow: z.boolean().default(true),
});

export const faqItemSchema = z.strictObject({
  question: z.string().trim().min(1, "Question is required").max(300, "Question is too long (max 300)"),
  answer: z.string().trim().min(1, "Answer is required").max(5000, "Answer is too long (max 5000)"),
});

export const MAX_FAQS = 50;

export const savePageContentSchema = z.strictObject({
  seo: seoFieldsSchema,
  htmlContent: z.string().max(50000, "HTML content is too long (max 50,000 characters)").default(""),
  faqEnabled: z.boolean().default(false),
  faqs: z.array(faqItemSchema).max(MAX_FAQS, `A maximum of ${MAX_FAQS} FAQs is allowed`).default([]),
});

export type SavePageContentInput = z.infer<typeof savePageContentSchema>;
