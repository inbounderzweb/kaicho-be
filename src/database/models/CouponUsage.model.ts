import { Schema, model, Document, Types } from "mongoose";
import { COUPON_DISCOUNT_TYPES, CouponDiscountType } from "./Coupon.model";

// One row per successful redemption. This is a real relationship table, not a
// boolean on the order — it's what the admin usage report reads and what the
// per-user limit counts.
//
// Two unique indexes carry the concurrency guarantees (there are no
// transactions on this DB):
//
//   { couponId, orderId }            — a coupon is consumed at most once for
//                                      a given order (idempotent retries, the
//                                      webhook + browser-verify double path).
//   { couponId, userId, perUserSeq } — the race-safe per-user cap. Each
//                                      redemption inserts with
//                                      seq = count(existing for this user)+1;
//                                      two concurrent inserts computing the
//                                      same seq collide here, forcing one to
//                                      retry and recompute — so N concurrent
//                                      checkouts can't all slip past a
//                                      usageLimitPerUser of 1.
//
// On order cancellation the row is DELETED and Coupon.usedCount decremented
// (full reversal, mirroring restoreStockForOrder). On refund it is kept — the
// order was fulfilled. See coupon.service.ts's releaseCouponForOrder().

export interface CouponUsageDocument extends Document {
  couponId: Types.ObjectId;
  couponCode: string;
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  discountType: CouponDiscountType;
  discountAmount: number;
  freeDelivery: boolean;
  perUserSeq: number;
  usedAt: Date;
}

const CouponUsageSchema = new Schema<CouponUsageDocument>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    couponCode: { type: String, required: true, trim: true, uppercase: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: { type: String, required: true },
    discountType: { type: String, enum: COUPON_DISCOUNT_TYPES, required: true },
    discountAmount: { type: Number, required: true, min: 0 },
    freeDelivery: { type: Boolean, required: true, default: false },
    perUserSeq: { type: Number, required: true, min: 1 },
    usedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false }
);

CouponUsageSchema.index({ couponId: 1, orderId: 1 }, { unique: true });
CouponUsageSchema.index({ couponId: 1, userId: 1, perUserSeq: 1 }, { unique: true });
// Per-user counting + the admin "this customer's redemptions" view.
CouponUsageSchema.index({ couponId: 1, userId: 1 });
// Admin usage history, most-recent first.
CouponUsageSchema.index({ couponId: 1, usedAt: -1 });
// Release-by-order lookup (order cancelled → find and delete the row).
CouponUsageSchema.index({ orderId: 1 });

export const CouponUsage = model<CouponUsageDocument>("CouponUsage", CouponUsageSchema);
