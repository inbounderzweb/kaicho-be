import { z } from "zod";
import { BLOG_CATEGORY_STATUSES } from "../../database/models";

const objectId = z
  .string({ error: "Image id must be text" })
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Selected image is invalid — please upload it again");

const optionalText = (label: string, max: number) =>
  z
    .string({ error: `${label} must be text` })
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .optional();

export const createBlogCategorySchema = z.object({
  name: z
    .string({ error: "Category name is required" })
    .trim()
    .min(1, "Category name is required")
    .max(120, "Category name must be 120 characters or fewer"),
  slug: z
    .string({ error: "Slug must be text" })
    .trim()
    .max(140, "Slug must be 140 characters or fewer")
    .regex(/^[a-z0-9-]*$/, "Slug can only contain lowercase letters, numbers, and hyphens")
    .optional(),
  description: optionalText("Description", 2000),
  // null / "" = no image (or remove the current one).
  imageMediaId: z.union([objectId, z.literal(""), z.null()], { error: "Selected image is invalid — please upload it again" }).optional(),
  metaTitle: optionalText("Meta title", 70),
  metaDescription: optionalText("Meta description", 200),
  status: z.enum(BLOG_CATEGORY_STATUSES, { error: "Status must be Active or Inactive" }).optional(),
});

export const updateBlogCategorySchema = createBlogCategorySchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: "Change at least one field before saving" });

export type CreateBlogCategoryInput = z.infer<typeof createBlogCategorySchema>;
export type UpdateBlogCategoryInput = z.infer<typeof updateBlogCategorySchema>;
