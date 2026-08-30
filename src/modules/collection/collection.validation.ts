import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const collectionProductSchema = z.object({
  productId: objectId,
  sortOrder: z.number().int().min(0),
});

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().max(140).optional(),
  description: z.string().trim().max(2000).optional(),
  imageMediaId: objectId.optional().or(z.literal("")),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  products: z.array(collectionProductSchema).optional(),
});

export const updateCollectionSchema = createCollectionSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

export const updateCollectionProductsSchema = z.object({
  products: z.array(collectionProductSchema),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
export type UpdateCollectionProductsInput = z.infer<typeof updateCollectionProductsSchema>;
