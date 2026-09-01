import { Schema, model, Document, Types } from "mongoose";

// Append-only audit trail for an inquiry. Written by inquiry.service.ts on
// every meaningful change; there are no update/delete endpoints — the admin UI
// renders it read-only. `userId` is null for the CREATED row (the customer
// submitted it) and for any future system-generated events.
export const INQUIRY_ACTIONS = ["CREATED", "STATUS_CHANGED", "ASSIGNED", "NOTE_ADDED", "UPDATED"] as const;
export type InquiryAction = (typeof INQUIRY_ACTIONS)[number];

export interface InquiryActivityDocument extends Document {
  inquiryId: Types.ObjectId;
  userId?: Types.ObjectId;
  action: InquiryAction;
  oldValue?: string;
  newValue?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InquiryActivitySchema = new Schema<InquiryActivityDocument>(
  {
    inquiryId: { type: Schema.Types.ObjectId, ref: "Inquiry", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, enum: INQUIRY_ACTIONS, required: true },
    oldValue: { type: String, trim: true, maxlength: 300 },
    newValue: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

export const InquiryActivity = model<InquiryActivityDocument>("InquiryActivity", InquiryActivitySchema);
