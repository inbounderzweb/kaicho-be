import { z } from "zod";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// Create: only `name` is required. `slug` is optional — omitted means
// auto-generate from `name`; supplied means "use this, but still normalized"
// (see slugify.ts), never trusted raw.
export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  collectionName: z.string().trim().max(160, "Collection name is too long").optional(),
  slug: z.string().trim().max(140).optional(),
  description: z.string().trim().max(2000).optional(),
  parentId: objectIdField.nullable().optional(),
  imageMediaId: objectIdField.nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

// Update: same fields, all optional, at least one required. Mass-assignment
// guard — storageKey/storageProvider/uploadedBy/createdAt/updatedAt/etc. are
// simply never listed, so Zod strips them regardless of what's sent.
export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120, "Name is too long").optional(),
    collectionName: z.string().trim().max(160, "Collection name is too long").optional(),
    slug: z.string().trim().max(140).optional(),
    description: z.string().trim().max(2000).optional(),
    parentId: objectIdField.nullable().optional(),
    imageMediaId: objectIdField.nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
