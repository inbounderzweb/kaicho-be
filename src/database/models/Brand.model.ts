import { Schema, model, Document, Types } from "mongoose";

// Mirrors Category.model.ts's shape (name/slug/description/image/isActive/
// sortOrder) since Brand is the same kind of lightweight, admin-managed
// taxonomy entity — just without a parent hierarchy. createdBy/updatedBy
// give basic auditability (who created/last touched this record), matching
// the same fields added to Product.
export interface BrandDocument extends Document {
  name: string;
  slug: string;
  description?: string;
  logoMediaId?: Types.ObjectId;
  isActive: boolean;
  sortOrder: number;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BrandSchema = new Schema<BrandDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, trim: true, unique: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000 },
    logoMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

BrandSchema.index({ isActive: 1, sortOrder: 1 });
BrandSchema.index({ createdAt: 1 });

export const Brand = model<BrandDocument>("Brand", BrandSchema);
