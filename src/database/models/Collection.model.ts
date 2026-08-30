import { Schema, model, Document, Types } from "mongoose";

export interface CollectionProductRef {
  productId: Types.ObjectId;
  sortOrder: number;
}

export interface CollectionDocument extends Document {
  name: string;
  slug: string;
  description?: string;
  imageMediaId?: Types.ObjectId;
  isActive: boolean;
  sortOrder: number;
  products: CollectionProductRef[];
  createdAt: Date;
  updatedAt: Date;
}

const CollectionProductSchema = new Schema<CollectionProductRef>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    sortOrder: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const CollectionSchema = new Schema<CollectionDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, unique: true },
    slug: { type: String, required: true, trim: true, maxlength: 140, unique: true },
    description: { type: String, trim: true, maxlength: 2000 },
    imageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0, min: 0 },
    products: { type: [CollectionProductSchema], default: [] },
  },
  { timestamps: true }
);

CollectionSchema.index({ isActive: 1, sortOrder: 1 });
CollectionSchema.index({ slug: 1 }, { unique: true });
CollectionSchema.index({ name: 1 }, { unique: true });

export const Collection = model<CollectionDocument>("Collection", CollectionSchema);
