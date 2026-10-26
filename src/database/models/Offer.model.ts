import { Schema, model, Document, Types } from "mongoose";

// An Offer is an automatic, cart-level promotion: Buy X Get Y Free ("BOGO"),
// a percentage discount, or a fixed amount off, each limited to the products
// the admin selected. `name` is the customer-facing offer title.
// It is the ONLY live source of an offer's *rules*; what an order actually
// received is recomputed backend-side at checkout and frozen onto
// Order.offer so history survives any later edit/disable of this document.
//
// Unlike a Coupon there is no code — the best applicable ACTIVE offer is
// applied automatically (see offer.service.ts#evaluateBestOffer).
//
// `usedCount` is mutated only through the atomic, limit-guarded `$inc` in
// offer.service.ts#consumeOfferForOrder (standalone mongod, no transactions —
// same constraint coupons and stock reservation document).
//
// SCHEDULED and EXPIRED are DERIVED, never stored: the stored statuses are
// DRAFT / ACTIVE / DISABLED, and getEffectiveOfferStatus() folds in the
// [startsAt, endsAt] window. An ACTIVE offer with a future start is
// SCHEDULED; one past its end is EXPIRED and is unusable regardless of what
// the column says.

// BOGO       = Buy X Get Y Free  (kept under its original value so existing
//              offers and order snapshots stay valid)
// PERCENTAGE = `discountPercent` off every unit of the eligible products
// FIXED      = `discountAmount` rupees off every unit (never below zero)
export const OFFER_TYPES = ["BOGO", "PERCENTAGE", "FIXED"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const OFFER_STORED_STATUSES = ["DRAFT", "ACTIVE", "DISABLED"] as const;
export type OfferStoredStatus = (typeof OFFER_STORED_STATUSES)[number];

export const OFFER_STATUSES = ["DRAFT", "SCHEDULED", "ACTIVE", "EXPIRED", "DISABLED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export interface OfferDocument extends Document {
  name: string;
  description?: string;
  type: OfferType;
  imageMediaId?: Types.ObjectId;

  // Eligibility is always explicit: either `applyToAll` is true, or at least
  // one product/category is listed. Exclusions always win.
  applyToAll: boolean;
  eligibleProductIds: Types.ObjectId[];
  eligibleCategoryIds: Types.ObjectId[];
  excludedProductIds: Types.ObjectId[];
  excludedCategoryIds: Types.ObjectId[];

  // BOGO only: the products the customer receives free. Empty on offers made
  // before this field existed — those keep their original behaviour (the
  // eligible products are both the ones bought and the ones given free).
  freeProductIds: Types.ObjectId[];
  // PERCENTAGE only: 0 < percent <= 100.
  discountPercent?: number;
  // FIXED only: rupees off each eligible unit.
  discountAmount?: number;

  // Buy `buyQuantity` paid units, get one eligible unit of equal-or-lower
  // price free. `maxFreeUnitsPerOrder` caps FREE units, not cart size.
  buyQuantity: number;
  maxFreeUnitsPerOrder: number;
  // Paid units cheaper than this can't unlock a free unit. 0 = no minimum.
  minPaidUnitPrice: number;
  // When false (default) a coupon can't be combined with this offer.
  allowCouponStacking: boolean;

  startsAt: Date | null;
  endsAt: Date | null;
  // null = unlimited. Counted in orders, not units.
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;

  status: OfferStoredStatus;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const objectIdArray = (ref: string) => ({
  type: [{ type: Schema.Types.ObjectId, ref }],
  default: [],
});

const OfferSchema = new Schema<OfferDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    type: { type: String, enum: OFFER_TYPES, required: true, default: "BOGO" },
    imageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },

    applyToAll: { type: Boolean, default: false },
    eligibleProductIds: objectIdArray("Product"),
    eligibleCategoryIds: objectIdArray("Category"),
    excludedProductIds: objectIdArray("Product"),
    excludedCategoryIds: objectIdArray("Category"),

    freeProductIds: objectIdArray("Product"),
    discountPercent: { type: Number, min: 0.01, max: 100 },
    discountAmount: { type: Number, min: 0.01, max: 10_000_000 },

    buyQuantity: { type: Number, required: true, default: 1, min: 1, max: 10, validate: Number.isInteger },
    maxFreeUnitsPerOrder: { type: Number, required: true, default: 1, min: 1, max: 100, validate: Number.isInteger },
    minPaidUnitPrice: { type: Number, default: 0, min: 0 },
    allowCouponStacking: { type: Boolean, default: false },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    usageLimit: { type: Number, default: null, min: 1 },
    usageLimitPerUser: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: OFFER_STORED_STATUSES, default: "DRAFT" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Checkout/storefront hot path: "ACTIVE offers whose window contains now".
OfferSchema.index({ status: 1, startsAt: 1, endsAt: 1 });
OfferSchema.index({ createdAt: -1 });

// Last-line guard for offers written outside the admin Zod schema.
OfferSchema.pre("validate", function (this: OfferDocument) {
  if (this.eligibleProductIds.length === 0) {
    throw new Error("Choose at least one eligible product");
  }
  if (this.type === "PERCENTAGE" && !(this.discountPercent && this.discountPercent > 0)) {
    throw new Error("Enter the discount percentage");
  }
  if (this.type === "FIXED" && !(this.discountAmount && this.discountAmount > 0)) {
    throw new Error("Enter the discount amount");
  }
  if (this.type !== "BOGO" && this.freeProductIds.length > 0) {
    throw new Error("Free products only apply to Buy X Get Y Free offers");
  }
  // NOTE: "a live BOGO offer must name its free product(s)" is enforced by the
  // admin API (adminOffer.service.ts#assertReadyToActivate), not here: offers
  // saved before free products existed legitimately have none and keep working
  // as pooled offers (see offer.service.ts#getOfferMode).
  const excluded = new Set(this.excludedProductIds.map(String));
  if (this.freeProductIds.some((id) => excluded.has(String(id)))) {
    throw new Error("A free product can't also be an excluded product");
  }
  if (this.startsAt && this.endsAt && this.endsAt.getTime() <= this.startsAt.getTime()) {
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

export const Offer = model<OfferDocument>("Offer", OfferSchema);
