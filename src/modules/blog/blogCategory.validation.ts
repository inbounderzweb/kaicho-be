import { z } from "zod";
import { BLOG_CATEGORY_STATUSES } from "../../database/models";

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const createBlogCategorySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  slug: z
    .string()
    .trim()
    .max(140)
    .regex(/^[a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens only")
    .optional()
    .or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  imageMediaId: objectId.optional().or(z.literal("")),
  metaTitle: z.string().trim().max(70).optional().or(z.literal("")),
  metaDescription: z.string().trim().max(200).optional().or(z.literal("")),
  status: z.enum(BLOG_CATEGORY_STATUSES).optional(),
});

export const updateBlogCategorySchema = createBlogCategorySchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type CreateBlogCategoryInput = z.infer<typeof createBlogCategorySchema>;
export type UpdateBlogCategoryInput = z.infer<typeof updateBlogCategorySchema>;
