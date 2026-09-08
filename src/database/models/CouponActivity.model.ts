import { Schema, model, Document, Types } from "mongoose";

// Append-only audit trail for a coupon — same shape and intent as
// InquiryActivity.model.ts. Written by adminCoupon.service.ts on every
// meaningful admin action; there are no update/delete endpoints, the admin UI
// renders it read-only. `userId` is the admin who performed the action.
//
// Redemptions are NOT logged here — CouponUsage is already that record. This
// trail is for configuration/lifecycle changes only (spec §21).
export const COUPON_ACTIONS = ["CREATED", "UPDATED", "ACTIVATED", "PAUSED", "ARCHIVED"] as const;
export type CouponAction = (typeof COUPON_ACTIONS)[number];

export interface CouponFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface CouponActivityDocument extends Document {
  couponId: Types.ObjectId;
  userId?: Types.ObjectId;
  action: CouponAction;
  // Populated for UPDATED — one entry per changed field, pre-formatted for
  // display ("20%" → "25%", "₹300" → "₹500").
  changes: CouponFieldChange[];
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CouponFieldChangeSchema = new Schema<CouponFieldChange>(
  {
    field: { type: String, required: true, trim: true, maxlength: 80 },
    from: { type: String, default: "", trim: true, maxlength: 300 },
    to: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { _id: false }
);

const CouponActivitySchema = new Schema<CouponActivityDocument>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, enum: COUPON_ACTIONS, required: true },
    changes: { type: [CouponFieldChangeSchema], default: [] },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// The detail page reads the most recent entries for one coupon.
CouponActivitySchema.index({ couponId: 1, createdAt: -1 });

export const CouponActivity = model<CouponActivityDocument>("CouponActivity", CouponActivitySchema);
