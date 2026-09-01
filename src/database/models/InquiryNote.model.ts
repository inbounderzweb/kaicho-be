import { Schema, model, Document, Types } from "mongoose";

// Internal, admin-only annotations on an inquiry. Kept in its own collection
// (not embedded) so it scales independently and no public route can ever
// accidentally select it. Nothing outside the admin surface reads this.
export interface InquiryNoteDocument extends Document {
  inquiryId: Types.ObjectId;
  userId: Types.ObjectId;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

const InquiryNoteSchema = new Schema<InquiryNoteDocument>(
  {
    inquiryId: { type: Schema.Types.ObjectId, ref: "Inquiry", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

export const InquiryNote = model<InquiryNoteDocument>("InquiryNote", InquiryNoteSchema);
