import { Schema, model, Document, Types } from "mongoose";

// Product deliberately does NOT store image URLs, media binaries, or even a
// `mediaIds` array. The Media module already supports many-to-one
// entityType/entityId attachment plus per-file isPrimary/sortOrder (see
// Media.model.ts) — that IS the "explicit ordering" mechanism the Product
// spec asks for, so Product images are derived at read time via
// Media.find({ entityType: "PRODUCT", entityId: product._id }) rather than
// duplicated here. Keeping ordering in exactly one place (Media) avoids a
// second source of truth that could drift from what's actually attached.
export const PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "OUT_OF_STOCK", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface ProductPricing {
  mrp: number;
  sellingPrice: number;
  costPrice?: number;
}

export interface ProductInventory {
  stockQuantity: number;
  lowStockThreshold: number;
  trackInventory: boolean;
}

export interface ProductSeo {
  title: string;
  description: string;
  keywords: string[];
  canonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageMediaId?: Types.ObjectId;
}

export interface ProductDocument extends Document {
  name: string;
  slug: string;
  sku: string;
  shortDescription: string;
  description: string;

  categoryId: Types.ObjectId;
  brandId: Types.ObjectId;

  pricing: ProductPricing;
  inventory: ProductInventory;
  seo: ProductSeo;

  status: ProductStatus;
  isFeatured: boolean;
  sortOrder: number;

  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const ProductPricingSchema = new Schema<ProductPricing>(
  {
    mrp: { type: Number, required: true, min: 0.01 },
    sellingPrice: { type: Number, required: true, min: 0.01 },
    costPrice: { type: Number, min: 0 },
  },
  { _id: false }
);

const ProductInventorySchema = new Schema<ProductInventory>(
  {
    stockQuantity: { type: Number, required: true, min: 0 },
    lowStockThreshold: { type: Number, default: 10, min: 0 },
    trackInventory: { type: Boolean, default: true },
  },
  { _id: false }
);

const ProductSeoSchema = new Schema<ProductSeo>(
  {
    title: { type: String, required: true, trim: true, maxlength: 70 },
    description: { type: String, required: true, trim: true, maxlength: 200 },
    keywords: {
      type: [String],
      required: true,
      validate: {
        validator: (value: string[]) => Array.isArray(value) && value.length > 0 && value.length <= 20,
        message: "Provide between 1 and 20 SEO keywords",
      },
    },
    canonicalUrl: { type: String, trim: true, maxlength: 500 },
    ogTitle: { type: String, trim: true, maxlength: 70 },
    ogDescription: { type: String, trim: true, maxlength: 200 },
    ogImageMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
  },
  { _id: false }
);

const ProductSchema = new Schema<ProductDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
    slug: { type: String, required: true, trim: true, unique: true, maxlength: 220 },
    sku: { type: String, required: true, trim: true, unique: true, uppercase: true, maxlength: 64 },
    shortDescription: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, required: true, trim: true, maxlength: 20000 },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true },

    pricing: { type: ProductPricingSchema, required: true },
    inventory: { type: ProductInventorySchema, required: true },
    seo: { type: ProductSeoSchema, required: true },

    status: { type: String, enum: PRODUCT_STATUSES, default: "DRAFT" },
    isFeatured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0, min: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ brandId: 1 });
ProductSchema.index({ status: 1 });
ProductSchema.index({ isFeatured: 1 });
ProductSchema.index({ createdAt: 1 });
ProductSchema.index({ sortOrder: 1 });
ProductSchema.index({ status: 1, isFeatured: 1, sortOrder: 1 });
ProductSchema.index({ categoryId: 1, status: 1 });

export const Product = model<ProductDocument>("Product", ProductSchema);
