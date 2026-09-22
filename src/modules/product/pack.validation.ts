import { z } from "zod";
import { PACK_CONFIG_MODES, PACK_RECOMMENDATION_STRATEGIES, RELATED_COMBO_MODES } from "../../database/models";
import { MAX_COMBINATION_QUANTITY } from "./packCombination.service";

// Shared by both the product-scoped (/admin/products/:id/packs) and
// category-scoped (/admin/categories/:id/packs) routers — a pack is the same
// shape regardless of which parent owns it (spec §15/§16).
const skuField = z
  .string()
  .trim()
  .max(64, "SKU is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "SKU can only contain letters, numbers, hyphens, and underscores")
  .transform((value) => value.toUpperCase())
  .optional();

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// A pack (or a product's own inventoryTracking, see product.validation
// additions below) can override which real products its purchase deducts.
// Shared shape — reused by both attachment points, spec §20.
export const inventoryComponentSchema = z.object({
  productId: objectIdField,
  quantity: z.number().int("Quantity must be a whole number").positive("Quantity must be at least 1"),
});
export const inventoryComponentsField = z.array(inventoryComponentSchema).max(50, "Too many components").optional();

export const createPackSchema = z.object({
  name: z.string().trim().min(1, "Pack name is required").max(120, "Pack name is too long"),
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be greater than 0")
    .max(MAX_COMBINATION_QUANTITY, "Quantity is too large"),
  price: z.number().min(0, "Price cannot be negative").max(10_000_000, "Price is unreasonably large"),
  sku: skuField,
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  useComponentInventory: z.boolean().optional(),
  inventoryComponents: inventoryComponentsField,
});

export type CreatePackInput = z.infer<typeof createPackSchema>;

export const updatePackSchema = z
  .object({
    name: z.string().trim().min(1, "Pack name is required").max(120, "Pack name is too long").optional(),
    quantity: z
      .number()
      .int("Quantity must be a whole number")
      .positive("Quantity must be greater than 0")
      .max(MAX_COMBINATION_QUANTITY, "Quantity is too large")
      .optional(),
    price: z.number().min(0, "Price cannot be negative").max(10_000_000, "Price is unreasonably large").optional(),
    sku: skuField,
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    useComponentInventory: z.boolean().optional(),
    inventoryComponents: inventoryComponentsField,
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdatePackInput = z.infer<typeof updatePackSchema>;

// The product-level inventory-tracking settings pair (/admin/products/:id/inventory-tracking).
export const updateInventoryTrackingSchema = z
  .object({
    enabled: z.boolean().optional(),
    components: inventoryComponentsField,
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateInventoryTrackingInput = z.infer<typeof updateInventoryTrackingSchema>;

// Related Combo/Bundle Suggestion settings (/admin/products/:id/related-combo).
// `comboProductId: null` explicitly clears a previously-pinned MANUAL
// target (switching back to AUTO without one would otherwise leave a stale
// id sitting in the document, unused but confusing to read back).
export const updateRelatedComboSchema = z
  .object({
    mode: z.enum(RELATED_COMBO_MODES).optional(),
    comboProductId: objectIdField.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateRelatedComboInput = z.infer<typeof updateRelatedComboSchema>;

// The enable/strategy/mixed-packs knobs, separate from individual pack rows
// — same "settings vs. rows" split coupon status has (setCouponStatusAdmin
// vs. updateCouponAdmin).
export const updatePackConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(PACK_CONFIG_MODES).optional(),
    mixedPacksAllowed: z.boolean().optional(),
    recommendationStrategy: z.enum(PACK_RECOMMENDATION_STRATEGIES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdatePackConfigInput = z.infer<typeof updatePackConfigSchema>;

// Category-level config has no `mode` (a category IS an inheritance source,
// it can't itself inherit).
export const updateCategoryPackConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mixedPacksAllowed: z.boolean().optional(),
    recommendationStrategy: z.enum(PACK_RECOMMENDATION_STRATEGIES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateCategoryPackConfigInput = z.infer<typeof updateCategoryPackConfigSchema>;
