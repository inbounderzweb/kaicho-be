import { Schema, model, Document, Types } from "mongoose";

export interface CategoryDocument extends Document {
  name: string;
  slug: string;
  description?: string;
  parentId?: Types.ObjectId;
  imageMediaId?: Types.ObjectId;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const CategorySchema = new Schema<CategoryDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, trim: true, unique: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000 },
    parentId: { type: Schema.Types.ObjectId, ref: "Category" },
    imageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

CategorySchema.index({ parentId: 1 });
CategorySchema.index({ isActive: 1, sortOrder: 1 });
CategorySchema.index({ createdAt: 1 });

export const Category = model<CategoryDocument>("Category", CategorySchema);
