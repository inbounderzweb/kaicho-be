import { Schema, model, Document, Types } from "mongoose";

// A Coupon is a reusable discount rule the admin configures. It is the ONLY
// live source of a discount's *rules*; the amount actually granted to an
// order is recomputed backend-side at checkout and then snapshotted onto the
// Order (Order.coupon) so historical pricing survives any later edit/pause/
// archive of this document (see Order.model.ts).
//
// `usedCount` is the authoritative global-usage counter. It is mutated only
// through the atomic `$inc` guarded by the usage limit in coupon.service.ts's
// consumeCouponForOrder() — never with a read-modify-write — because the DB
// is standalone mongod with no transactions (same constraint the checkout
// stock reservation documents).
//
// `EXPIRED` is deliberately NOT a stored status: effective validity is
// `status === "ACTIVE"` AND now within [startsAt, expiresAt]. See
// getEffectiveCouponStatus() — a coupon whose stored status wrongly says
// ACTIVE past its expiry is still unusable.

export const COUPON_DISCOUNT_TYPES = ["PERCENTAGE", "FIXED", "FREE_DELIVERY"] as const;
export type CouponDiscountType = (typeof COUPON_DISCOUNT_TYPES)[number];

export const COUPON_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

export interface CouponDocument extends Document {
  code: string;
  name: string;
  description?: string;
  discountType: CouponDiscountType;
  // Percentage points (1–100) for PERCENTAGE, rupees for FIXED, ignored (0)
  // for FREE_DELIVERY.
  discountValue: number;
  // Percentage-coupon cap, in rupees. null = uncapped. Meaningless for the
  // other two types.
  maxDiscountAmount: number | null;
  minOrderValue: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  // null = unlimited.
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;
  status: CouponStatus;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CouponSchema = new Schema<CouponDocument>(
  {
    // `uppercase` normalises at the schema layer too, but the real guarantee
    // is the unique index — coupon.service.ts canonicalises every lookup with
    // canonicalizeCouponCode() so "kaicho10" / "Kaicho10" / " KAICHO10 " all
    // resolve to the one stored "KAICHO10".
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 40,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    discountType: { type: String, enum: COUPON_DISCOUNT_TYPES, required: true },
    discountValue: { type: Number, required: true, min: 0 },
    maxDiscountAmount: { type: Number, default: null, min: 0 },
    minOrderValue: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    usageLimit: { type: Number, default: null, min: 1 },
    usageLimitPerUser: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: COUPON_STATUSES, default: "DRAFT" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Admin listing filters/sorts on status and expiry; the validation lookup
// hits `code` (already uniquely indexed).
CouponSchema.index({ status: 1 });
CouponSchema.index({ status: 1, expiresAt: 1 });

// Cross-field / type-specific rules that a plain `min` can't express. These
// are a last-line guard for coupons created directly (tests, scripts, a
// future import); the admin Zod schema (coupon.validation on the admin
// routes) is the primary gate with friendlier messages. A thrown error in a
// sync pre-validate hook is surfaced by Mongoose as a ValidationError.
CouponSchema.pre("validate", function (this: CouponDocument) {
  if (this.discountType === "PERCENTAGE" && (this.discountValue <= 0 || this.discountValue > 100)) {
    throw new Error("Percentage discount must be between 1 and 100");
  }
  if (this.discountType === "FIXED" && this.discountValue <= 0) {
    throw new Error("Fixed discount must be greater than 0");
  }
  if (this.startsAt && this.expiresAt && this.expiresAt.getTime() <= this.startsAt.getTime()) {
    throw new Error("End date must be after the start date");
  }
  if (
    this.usageLimit != null &&
    this.usageLimitPerUser != null &&
    this.usageLimitPerUser > this.usageLimit
  ) {
    throw new Error("Per-user usage limit cannot exceed the total usage limit");
  }
});

export const Coupon = model<CouponDocument>("Coupon", CouponSchema);
