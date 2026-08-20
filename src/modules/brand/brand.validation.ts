import { z } from "zod";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// Create: only `name` is required. `slug` is optional — omitted means
// auto-generate from `name`; supplied means "use this, but still normalized"
// (see slugify.ts), never trusted raw. Mirrors category.validation.ts.
export const createBrandSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  slug: z.string().trim().max(140).optional(),
  description: z.string().trim().max(2000).optional(),
  logoMediaId: objectIdField.nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export type CreateBrandInput = z.infer<typeof createBrandSchema>;

// Update: same fields, all optional, at least one required. Mass-assignment
// guard — createdBy/updatedBy/createdAt/updatedAt are simply never listed,
// so Zod strips them regardless of what's sent.
export const updateBrandSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120, "Name is too long").optional(),
    slug: z.string().trim().max(140).optional(),
    description: z.string().trim().max(2000).optional(),
    logoMediaId: objectIdField.nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
