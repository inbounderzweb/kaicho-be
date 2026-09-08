import { z } from "zod";
import { COUPON_DISCOUNT_TYPES } from "../../database/models";

// All money fields are rupees on the wire — same convention as
// Order.pricing / Product.pricing / the refund endpoint. The paise-only maths
// happens server-side in coupon.service.
//
// Backend is authoritative (spec §16): every rule here is also enforced, and
// the Coupon model's pre('validate') hook is the final backstop for coupons
// written by any path.

const money = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(10_000_000, `${label} is unreasonably large`);

const positiveInt = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(1, `${label} must be at least 1`)
    .max(10_000_000, `${label} is unreasonably large`);

// letters/digits to start, then letters/digits/-/_ — no spaces (canonicalised
// server-side anyway) and no regex metacharacters that could reach a $regex.
const codeField = z
  .string()
  .trim()
  .min(3, "Code must be at least 3 characters")
  .max(40, "Code is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use letters, digits, hyphens and underscores only");

const baseCouponShape = {
  code: codeField,
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
  discountType: z.enum(COUPON_DISCOUNT_TYPES),
  discountValue: money("Discount value"),
  maxDiscountAmount: money("Maximum discount").positive("Maximum discount must be greater than 0").nullable().optional(),
  minOrderValue: money("Minimum order value").optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  usageLimit: positiveInt("Total usage limit").nullable().optional(),
  usageLimitPerUser: positiveInt("Per-user usage limit").nullable().optional(),
};

// Cross-field rules shared by create and update. Only checks the pairs that
// are actually present, so a partial update isn't rejected for a field it
// didn't touch — the service re-validates the merged document.
function refineCoupon(
  data: {
    discountType?: string;
    discountValue?: number;
    maxDiscountAmount?: number | null;
    startsAt?: Date | null;
    expiresAt?: Date | null;
    usageLimit?: number | null;
    usageLimitPerUser?: number | null;
  },
  ctx: z.RefinementCtx
) {
  if (data.discountType === "PERCENTAGE" && data.discountValue !== undefined) {
    if (data.discountValue < 1 || data.discountValue > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "Percentage discount must be between 1 and 100",
      });
    }
  }
  if (data.discountType === "FIXED" && data.discountValue !== undefined && data.discountValue <= 0) {
    ctx.addIssue({
      code: "custom",
      path: ["discountValue"],
      message: "Fixed discount must be greater than 0",
    });
  }
  if (
    data.startsAt != null &&
    data.expiresAt != null &&
    data.expiresAt.getTime() <= data.startsAt.getTime()
  ) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "End date must be after the start date" });
  }
  if (
    data.usageLimit != null &&
    data.usageLimitPerUser != null &&
    data.usageLimitPerUser > data.usageLimit
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["usageLimitPerUser"],
      message: "Per-user limit cannot exceed the total usage limit",
    });
  }
}

export const couponCreateSchema = z
  .object({
    ...baseCouponShape,
    minOrderValue: money("Minimum order value").default(0),
    // ARCHIVED is a lifecycle end state reached via the status endpoint, not
    // something a coupon can be born into.
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]).default("DRAFT"),
  })
  .superRefine(refineCoupon);

export const couponUpdateSchema = z
  .object({
    ...baseCouponShape,
    name: baseCouponShape.name.optional(),
    discountType: z.enum(COUPON_DISCOUNT_TYPES).optional(),
    discountValue: money("Discount value").optional(),
    code: codeField.optional(),
  })
  .partial()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: "custom", message: "Provide at least one field to update" });
    }
    refineCoupon(data, ctx);
  });

export const couponStatusSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
  note: z.string().trim().max(300, "Note is too long").optional(),
});

export type CouponCreateInput = z.infer<typeof couponCreateSchema>;
export type CouponUpdateInput = z.infer<typeof couponUpdateSchema>;
export type CouponStatusInput = z.infer<typeof couponStatusSchema>;
