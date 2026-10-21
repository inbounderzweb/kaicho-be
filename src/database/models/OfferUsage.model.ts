import { Schema, model, Document, Types } from "mongoose";

// One row per ORDER that redeemed an offer. Mirrors CouponUsage: the unique
// indexes are what make redemption race-safe on a standalone mongod —
//   (offerId, orderId)            a retry for the same order is a no-op
//   (offerId, userId, perUserSeq) concurrent redemptions by one user serialise
// Deleted when the order is cancelled (full reversal); kept on refund.
export interface OfferUsageDocument extends Document {
  offerId: Types.ObjectId;
  offerName: string;
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  freeUnits: number;
  discountAmount: number;
  perUserSeq: number;
  usedAt: Date;
}

const OfferUsageSchema = new Schema<OfferUsageDocument>(
  {
    offerId: { type: Schema.Types.ObjectId, ref: "Offer", required: true },
    offerName: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: { type: String, required: true },
    freeUnits: { type: Number, required: true, min: 1 },
    discountAmount: { type: Number, required: true, min: 0 },
    perUserSeq: { type: Number, required: true, min: 1 },
    usedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false }
);

OfferUsageSchema.index({ offerId: 1, orderId: 1 }, { unique: true });
OfferUsageSchema.index({ offerId: 1, userId: 1, perUserSeq: 1 }, { unique: true });
OfferUsageSchema.index({ offerId: 1, userId: 1 });
OfferUsageSchema.index({ offerId: 1, usedAt: -1 });
OfferUsageSchema.index({ orderId: 1 });

export const OfferUsage = model<OfferUsageDocument>("OfferUsage", OfferUsageSchema);
