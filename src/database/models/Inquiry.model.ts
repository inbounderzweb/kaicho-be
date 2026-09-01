import { Schema, model, Document, Types } from "mongoose";

// One unified collection for every lead-capture form on the site. `formType`
// is the discriminator — adding a "distributor" / "partnership" form later is a
// new entry in this array plus a submit schema/route/form, with no change to
// the admin list/detail/notes/activity/assignment/stats (all formType-agnostic).
export const INQUIRY_FORM_TYPES = ["bulk_order", "contact"] as const;
export type InquiryFormType = (typeof INQUIRY_FORM_TYPES)[number];

// A CRM pipeline, not an order lifecycle: admins reclassify freely, so any
// status -> any status is allowed and every change is written to
// InquiryActivity. There is deliberately no transition table.
export const INQUIRY_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUOTED",
  "NEGOTIATING",
  "CONVERTED",
  "CLOSED",
  "NOT_INTERESTED",
  "INVALID",
] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export interface InquiryDocument extends Document {
  inquiryNumber: string;
  formType: InquiryFormType;

  name: string;
  email: string;
  phone?: string;

  // Bulk-order-only fields — absent on contact inquiries.
  quantity?: number;
  purpose?: string;

  // The main message on a contact inquiry; the optional "additional message"
  // on a bulk-order inquiry.
  message?: string;

  status: InquiryStatus;
  assignedTo?: Types.ObjectId;

  // Null for public submissions; set only when an admin creates one manually.
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const InquirySchema = new Schema<InquiryDocument>(
  {
    inquiryNumber: { type: String, required: true, unique: true, trim: true },
    formType: { type: String, enum: INQUIRY_FORM_TYPES, required: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
    phone: { type: String, trim: true, maxlength: 40 },

    quantity: { type: Number, min: 1 },
    purpose: { type: String, trim: true, maxlength: 200 },
    message: { type: String, trim: true, maxlength: 5000 },

    status: { type: String, enum: INQUIRY_STATUSES, default: "NEW" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// `inquiryNumber` already carries `unique: true` on the field definition.
InquirySchema.index({ formType: 1, status: 1, createdAt: -1 });
InquirySchema.index({ status: 1 });
InquirySchema.index({ assignedTo: 1 });
InquirySchema.index({ createdAt: -1 });
InquirySchema.index({ name: "text", email: "text", message: "text", purpose: "text" });

export const Inquiry = model<InquiryDocument>("Inquiry", InquirySchema);
