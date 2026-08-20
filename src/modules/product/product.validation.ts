import { z } from "zod";
import { PRODUCT_STATUSES } from "../../database/models";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// Letters, digits, hyphens, underscores only — normalized to uppercase so
// "bmo-500" and "BMO-500" are treated as the same SKU both for the uniqueness
// check and for display. Never trusted raw from the client beyond that.
const skuField = z
  .string()
  .trim()
  .min(2, "SKU is too short")
  .max(64, "SKU is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "SKU can only contain letters, numbers, hyphens, and underscores")
  .transform((value) => value.toUpperCase());

// Deduplicates, trims, lowercases, and drops empty entries — this is the
// normalization spec §22 requires happen server-side regardless of what the
// client sends, not just client-side. Bounds are enforced *after*
// normalization so "provide at least 1" can't be satisfied by whitespace-only
// entries that collapse to nothing.
const keywordsField = z
  .array(z.string())
  .transform((values) => {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of values) {
      const keyword = raw.trim().toLowerCase();
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      normalized.push(keyword);
    }
    return normalized;
  })
  .refine((values) => values.length >= 1, { message: "At least one SEO keyword is required" })
  .refine((values) => values.length <= 20, { message: "A maximum of 20 SEO keywords is allowed" });

// Hard outer bounds only — the 30-60 / 120-160 "recommended" ranges from the
// spec are UX guidance (character counters, non-blocking), not validation
// rejections. See ProductDetailClient's SEO section on the frontend.
const seoSchema = z.object({
  title: z.string().trim().min(10, "SEO title is too short").max(70, "SEO title is too long"),
  description: z.string().trim().min(40, "SEO description is too short").max(200, "SEO description is too long"),
  keywords: keywordsField,
  canonicalUrl: z.string().trim().max(500).optional(),
  ogTitle: z.string().trim().max(70).optional(),
  ogDescription: z.string().trim().max(200).optional(),
  ogImageMediaId: objectIdField.nullable().optional(),
});

const pricingSchema = z
  .object({
    mrp: z.number().positive("MRP must be greater than 0").max(10_000_000, "MRP is unreasonably large"),
    sellingPrice: z.number().positive("Selling price must be greater than 0").max(10_000_000, "Selling price is unreasonably large"),
    costPrice: z.number().min(0, "Cost price cannot be negative").max(10_000_000).optional(),
  })
  .refine((data) => data.sellingPrice <= data.mrp, {
    message: "Selling price cannot be greater than MRP",
    path: ["sellingPrice"],
  });

const inventorySchema = z.object({
  stockQuantity: z.number().int("Stock quantity must be a whole number").min(0, "Stock quantity cannot be negative"),
  lowStockThreshold: z.number().int().min(0, "Low stock threshold cannot be negative").optional(),
  trackInventory: z.boolean().optional(),
});

export const createProductSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(200, "Name is too long")
    .refine((v) => v.length > 0, "Name cannot be only whitespace"),
  slug: z.string().trim().max(220).optional(),
  sku: skuField,
  shortDescription: z.string().trim().min(1, "Short description is required").max(300, "Short description is too long"),
  description: z.string().trim().min(1, "Description is required").max(20000, "Description is too long"),
  categoryId: objectIdField,
  brandId: objectIdField,
  mediaIds: z
    .array(objectIdField)
    .min(1, "At least one product image is required")
    .max(20, "A maximum of 20 images is allowed"),
  pricing: pricingSchema,
  inventory: inventorySchema,
  seo: seoSchema,
  status: z.enum(PRODUCT_STATUSES).optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

// Partial counterparts of the nested objects — an update may touch a single
// field (e.g. just stockQuantity) without resending the whole sub-object.
// Cross-field invariants that depend on the *existing* document (e.g.
// sellingPrice <= mrp when only one of the two is being changed) are
// re-checked in product.service.ts against the merged result, not here.
const partialPricingSchema = z.object({
  mrp: z.number().positive("MRP must be greater than 0").max(10_000_000).optional(),
  sellingPrice: z.number().positive("Selling price must be greater than 0").max(10_000_000).optional(),
  costPrice: z.number().min(0, "Cost price cannot be negative").max(10_000_000).optional(),
});

const partialInventorySchema = z.object({
  stockQuantity: z.number().int("Stock quantity must be a whole number").min(0, "Stock quantity cannot be negative").optional(),
  lowStockThreshold: z.number().int().min(0, "Low stock threshold cannot be negative").optional(),
  trackInventory: z.boolean().optional(),
});

const partialSeoSchema = z.object({
  title: z.string().trim().min(10, "SEO title is too short").max(70, "SEO title is too long").optional(),
  description: z.string().trim().min(40, "SEO description is too short").max(200, "SEO description is too long").optional(),
  keywords: keywordsField.optional(),
  canonicalUrl: z.string().trim().max(500).optional(),
  ogTitle: z.string().trim().max(70).optional(),
  ogDescription: z.string().trim().max(200).optional(),
  ogImageMediaId: objectIdField.nullable().optional(),
});

// Mass-assignment guard — createdBy/updatedBy/createdAt/updatedAt are simply
// never listed, so Zod strips them regardless of what's sent, same pattern
// as category.validation.ts / adminUsers.validation.ts.
export const updateProductSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(200, "Name is too long")
      .optional(),
    slug: z.string().trim().max(220).optional(),
    sku: skuField.optional(),
    shortDescription: z.string().trim().min(1, "Short description is required").max(300).optional(),
    description: z.string().trim().min(1, "Description is required").max(20000).optional(),
    categoryId: objectIdField.optional(),
    brandId: objectIdField.optional(),
    mediaIds: z
      .array(objectIdField)
      .min(1, "At least one product image is required")
      .max(20, "A maximum of 20 images is allowed")
      .optional(),
    pricing: partialPricingSchema.optional(),
    inventory: partialInventorySchema.optional(),
    seo: partialSeoSchema.optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
    isFeatured: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateProductInput = z.infer<typeof updateProductSchema>;
