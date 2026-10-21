import { Schema, model, Document, Types } from "mongoose";

// Append-only audit trail for an offer (same shape as CouponActivity).
// Redemptions are NOT logged here — OfferUsage is that record.
export const OFFER_ACTIONS = ["CREATED", "UPDATED", "ACTIVATED", "DISABLED"] as const;
export type OfferAction = (typeof OFFER_ACTIONS)[number];

export interface OfferFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface OfferActivityDocument extends Document {
  offerId: Types.ObjectId;
  userId?: Types.ObjectId;
  action: OfferAction;
  changes: OfferFieldChange[];
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OfferFieldChangeSchema = new Schema<OfferFieldChange>(
  {
    field: { type: String, required: true, trim: true, maxlength: 80 },
    from: { type: String, default: "", trim: true, maxlength: 300 },
    to: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { _id: false }
);

const OfferActivitySchema = new Schema<OfferActivityDocument>(
  {
    offerId: { type: Schema.Types.ObjectId, ref: "Offer", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, enum: OFFER_ACTIONS, required: true },
    changes: { type: [OfferFieldChangeSchema], default: [] },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

OfferActivitySchema.index({ offerId: 1, createdAt: -1 });

export const OfferActivity = model<OfferActivityDocument>("OfferActivity", OfferActivitySchema);
