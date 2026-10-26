import { z } from "zod";
import { OFFER_TYPES } from "../../database/models";

// Money fields are rupees on the wire (same convention as Coupon / Product).
// Every rule here is ALSO enforced by the Offer model's pre('validate') hook
// and the service; this schema is the primary gate with friendly messages.

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

const idList = (label: string) =>
  z
    .array(objectIdField)
    .max(500, `${label}: too many entries`)
    .transform((ids) => [...new Set(ids)]);

const positiveInt = (label: string, max: number) =>
  z
    .number({ message: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(1, `${label} must be at least 1`)
    .max(max, `${label} can't be more than ${max}`);

// Percent with at most 2 decimals, 0 < p <= 100.
const percentField = z
  .number({ message: "Discount percentage must be a number" })
  .gt(0, "Discount percentage must be greater than 0")
  .max(100, "Discount percentage can't be more than 100")
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-9, "Use at most 2 decimal places");

const amountField = z
  .number({ message: "Discount amount must be a number" })
  .gt(0, "Discount amount must be greater than 0")
  .max(10_000_000, "Discount amount is unreasonably large")
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-9, "Use at most 2 decimal places");

const baseOfferShape = {
  // The offer title shown to customers on product cards, the cart and banners.
  name: z.string().trim().min(1, "Offer title is required").max(120, "Offer title is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
  type: z.enum(OFFER_TYPES),
  imageMediaId: objectIdField.nullable().optional(),

  // Blanket "all products" offers are not allowed — eligibility must be explicit.
  applyToAll: z.literal(false, { message: "Offers can only apply to selected products or categories" }),
  eligibleProductIds: idList("Eligible products"),
  eligibleCategoryIds: z.array(objectIdField).max(0, "Offers apply to selected products only"),
  excludedProductIds: idList("Excluded products"),
  excludedCategoryIds: idList("Excluded categories"),

  // Buy X Get Y Free: the products given free.
  freeProductIds: idList("Free products"),
  discountPercent: percentField.nullable().optional(),
  discountAmount: amountField.nullable().optional(),

  buyQuantity: positiveInt("Purchase quantity", 10),
  maxFreeUnitsPerOrder: positiveInt("Maximum free units per order", 100),
  minPaidUnitPrice: z
    .number({ message: "Minimum purchased product price must be a number" })
    .min(0, "Minimum purchased product price cannot be negative")
    .max(10_000_000, "Minimum purchased product price is unreasonably large"),
  allowCouponStacking: z.boolean(),

  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  usageLimit: positiveInt("Total usage limit", 10_000_000).nullable().optional(),
  usageLimitPerUser: positiveInt("Per-user usage limit", 10_000_000).nullable().optional(),
};

type RefineShape = {
  type?: "BOGO" | "PERCENTAGE" | "FIXED";
  status?: "DRAFT" | "SCHEDULED" | "ACTIVE" | "DISABLED";
  applyToAll?: boolean;
  eligibleProductIds?: string[];
  eligibleCategoryIds?: string[];
  excludedProductIds?: string[];
  freeProductIds?: string[];
  discountPercent?: number | null;
  discountAmount?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  usageLimitPerUser?: number | null;
};

// Only checks pairs that are actually present, so a partial update isn't
// rejected for a field it didn't touch — the service re-validates the merged
// document.
function refineOffer(data: RefineShape, ctx: z.RefinementCtx, requireScope: boolean) {
  if (
    requireScope &&
    (data.eligibleProductIds?.length ?? 0) === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["eligibleProductIds"],
      message: "Choose at least one eligible product",
    });
  }
  // Per-type configuration. On create the whole shape is present; on a
  // partial update only what was sent is checked here, and the service
  // re-validates the merged document.
  if (data.type === "PERCENTAGE" && requireScope && data.discountPercent == null) {
    ctx.addIssue({ code: "custom", path: ["discountPercent"], message: "Enter the discount percentage" });
  }
  if (data.type === "FIXED" && requireScope && data.discountAmount == null) {
    ctx.addIssue({ code: "custom", path: ["discountAmount"], message: "Enter the discount amount" });
  }
  if (data.type !== undefined && data.type !== "BOGO" && (data.freeProductIds?.length ?? 0) > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["freeProductIds"],
      message: "Free products only apply to Buy X Get Y Free offers",
    });
  }
  if (data.type === "BOGO" && (data.discountPercent != null || data.discountAmount != null)) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: "A Buy X Get Y Free offer has no discount percentage or amount",
    });
  }
  if (data.type === "PERCENTAGE" && data.discountAmount != null) {
    ctx.addIssue({ code: "custom", path: ["discountAmount"], message: "A percentage offer has no fixed amount" });
  }
  if (data.type === "FIXED" && data.discountPercent != null) {
    ctx.addIssue({ code: "custom", path: ["discountPercent"], message: "A fixed-amount offer has no percentage" });
  }
  // A BOGO offer can't go live until it says what is free.
  if (
    requireScope &&
    data.type === "BOGO" &&
    (data.status === "ACTIVE" || data.status === "SCHEDULED") &&
    (data.freeProductIds?.length ?? 0) === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["freeProductIds"],
      message: "Choose the free product(s) before activating a Buy X Get Y Free offer",
    });
  }
  if (data.freeProductIds && data.excludedProductIds) {
    const excluded = new Set(data.excludedProductIds);
    if (data.freeProductIds.some((id) => excluded.has(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["freeProductIds"],
        message: "A free product can't also be an excluded product",
      });
    }
  }
  if (data.startsAt != null && data.endsAt != null && data.endsAt.getTime() <= data.startsAt.getTime()) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after the start date" });
  }
  if (data.usageLimit != null && data.usageLimitPerUser != null && data.usageLimitPerUser > data.usageLimit) {
    ctx.addIssue({
      code: "custom",
      path: ["usageLimitPerUser"],
      message: "Per-user limit cannot exceed the total usage limit",
    });
  }
}

export const offerCreateSchema = z
  .object({
    ...baseOfferShape,
    type: z.enum(OFFER_TYPES).default("BOGO"),
    applyToAll: z.literal(false).default(false),
    eligibleProductIds: baseOfferShape.eligibleProductIds.default([]),
    eligibleCategoryIds: baseOfferShape.eligibleCategoryIds.default([]),
    excludedProductIds: baseOfferShape.excludedProductIds.default([]),
    excludedCategoryIds: baseOfferShape.excludedCategoryIds.default([]),
    freeProductIds: baseOfferShape.freeProductIds.default([]),
    buyQuantity: baseOfferShape.buyQuantity.default(1),
    maxFreeUnitsPerOrder: baseOfferShape.maxFreeUnitsPerOrder.default(1),
    minPaidUnitPrice: baseOfferShape.minPaidUnitPrice.default(0),
    allowCouponStacking: z.boolean().default(false),
    // SCHEDULED is an alias for ACTIVE-with-a-future-start (checked in the
    // service); EXPIRED is derived and can't be chosen.
    status: z.enum(["DRAFT", "SCHEDULED", "ACTIVE", "DISABLED"]).default("DRAFT"),
  })
  .superRefine((data, ctx) => refineOffer(data, ctx, true));

export const offerUpdateSchema = z
  .object(baseOfferShape)
  .partial()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: "custom", message: "Provide at least one field to update" });
    }
    refineOffer(data, ctx, false);
  });

export const offerStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SCHEDULED", "DISABLED"]),
  note: z.string().trim().max(300, "Note is too long").optional(),
});

export const offerSimulateSchema = z.object({
  items: z
    .array(
      z.object({
        productId: objectIdField,
        quantity: z.number().int().min(1).max(1000),
      })
    )
    .min(1, "Add at least one item")
    .max(50),
  freeSelections: z
    .array(z.object({ productId: objectIdField, quantity: z.number().int().min(1).max(1000) }))
    .max(50)
    .optional(),
});

export type OfferCreateInput = z.infer<typeof offerCreateSchema>;
export type OfferUpdateInput = z.infer<typeof offerUpdateSchema>;
export type OfferStatusInput = z.infer<typeof offerStatusSchema>;
export type OfferSimulateInput = z.infer<typeof offerSimulateSchema>;
