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

const baseOfferShape = {
  name: z.string().trim().min(1, "Offer name is required").max(120, "Offer name is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
  type: z.enum(OFFER_TYPES),
  imageMediaId: objectIdField.nullable().optional(),

  // Blanket "all products" offers are not allowed — eligibility must be explicit.
  applyToAll: z.literal(false, { message: "Offers can only apply to selected products or categories" }),
  eligibleProductIds: idList("Eligible products"),
  eligibleCategoryIds: z.array(objectIdField).max(0, "Offers apply to selected products only"),
  excludedProductIds: idList("Excluded products"),
  excludedCategoryIds: idList("Excluded categories"),

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
  applyToAll?: boolean;
  eligibleProductIds?: string[];
  eligibleCategoryIds?: string[];
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
