import { z } from "zod";
import { BLOG_STATUSES } from "../../database/models";

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const optionalObjectId = objectId.optional().or(z.literal(""));

const urlOrEmpty = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\//i.test(v), "Must be an absolute http(s) URL")
  .optional();

export const blogSeoSchema = z.object({
  metaTitle: z.string().trim().max(70).optional().or(z.literal("")),
  metaDescription: z.string().trim().max(200).optional().or(z.literal("")),
  focusKeyword: z.string().trim().max(120).optional().or(z.literal("")),
  canonicalUrl: urlOrEmpty.or(z.literal("")),
  ogTitle: z.string().trim().max(120).optional().or(z.literal("")),
  ogDescription: z.string().trim().max(200).optional().or(z.literal("")),
  ogImageMediaId: optionalObjectId,
  noIndex: z.boolean().optional(),
  noFollow: z.boolean().optional(),
});

export const blogFaqSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(2000),
});

// The editor sends tag *names* (type-to-search, create-on-enter); the service
// upserts each to a BlogTag by slug. Avoids a create-tag round trip per new
// label and keeps duplicate prevention in one place.
const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(30).optional();

export const createBlogSchema = z.object({
  title: z.string().trim().min(2, "Title is required").max(200, "Title is too long"),
  slug: z
    .string()
    .trim()
    .max(220)
    .regex(/^[a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens only")
    .optional()
    .or(z.literal("")),
  excerpt: z.string().trim().min(1, "Excerpt is required").max(320, "Excerpt is too long"),
  contentHtml: z.string().max(200000, "Content is too long").optional(),
  featuredImageMediaId: optionalObjectId,
  thumbnailImageMediaId: optionalObjectId,
  author: optionalObjectId,
  authorName: z.string().trim().max(120).optional().or(z.literal("")),
  categoryId: objectId,
  tags: tagsSchema,
  seo: blogSeoSchema.optional(),
  faqs: z.array(blogFaqSchema).max(30).optional(),
  relatedBlogIds: z.array(objectId).max(12).optional(),
  schemaEnabled: z.boolean().optional(),
});

export const updateBlogSchema = createBlogSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

// Status changes go through their own endpoints so the transition table
// (BLOG_STATUS_TRANSITIONS) is the only gate. `scheduledFor` is required when
// moving to SCHEDULED and must be in the future.
export const blogStatusSchema = z
  .object({
    status: z.enum(BLOG_STATUSES),
    scheduledFor: z.coerce.date().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((d) => d.status !== "SCHEDULED" || (d.scheduledFor && d.scheduledFor.getTime() > Date.now()), {
    message: "A future scheduledFor date is required to schedule a post",
    path: ["scheduledFor"],
  });

export const blogScheduleSchema = z.object({
  scheduledFor: z.coerce.date().refine((d) => d.getTime() > Date.now(), {
    message: "scheduledFor must be in the future",
  }),
  note: z.string().trim().max(300).optional(),
});

export const bulkBlogActionSchema = z.object({
  ids: z.array(objectId).min(1, "Select at least one post").max(100),
  action: z.enum(["publish", "unpublish", "archive", "delete"]),
});

export type CreateBlogInput = z.infer<typeof createBlogSchema>;
export type UpdateBlogInput = z.infer<typeof updateBlogSchema>;
export type BlogStatusInput = z.infer<typeof blogStatusSchema>;
export type BlogScheduleInput = z.infer<typeof blogScheduleSchema>;
export type BulkBlogActionInput = z.infer<typeof bulkBlogActionSchema>;
