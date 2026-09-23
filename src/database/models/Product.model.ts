import { Schema, model, Document, Types } from "mongoose";
import { ProductPackConfig, ProductPackConfigSchema, InventoryTracking, InventoryTrackingSchema } from "./PackConfig.schema";

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

export const RELATED_COMBO_MODES = ["AUTO", "MANUAL", "NONE"] as const;
export type RelatedComboMode = (typeof RELATED_COMBO_MODES)[number];

// "Is there a bundle/combo the customer should be offered instead of buying
// this product plain?" — absent or "AUTO" (every product created before
// this feature, and any new one that never opts out) means the backend
// looks for one automatically from the inventoryTracking relationships that
// already exist (see relatedCombo.service.ts); "MANUAL" pins one exact
// product regardless of whether it's actually built from this one as a
// component; "NONE" suppresses the suggestion outright.
export interface RelatedCombo {
  mode: RelatedComboMode;
  comboProductId?: Types.ObjectId;
}

export interface ProductDocument extends Document {
  name: string;
  slug: string;
  sku: string;
  weightPerPackGrams?: number | null;
  numberOfPacks?: number | null;
  shortDescription: string;
  description: string;

  categoryId: Types.ObjectId;
  brandId: Types.ObjectId;

  pricing: ProductPricing;
  inventory: ProductInventory;
  seo: ProductSeo;

  // Absent (undefined) on every product created before this feature existed,
  // and on any new product that never opts in — see PackConfig.schema.ts's
  // header comment for why packs never touch inventory/discount storage.
  packConfig?: ProductPackConfig;

  // Governs a PLAIN/base purchase of this product (quantity=N, no pack
  // selected) — absent/disabled means today's exact behaviour (deduct from
  // this product's own `inventory.stockQuantity`). Enabled, this product IS
  // a combo: buying N of it deducts N × each component's quantity from the
  // referenced products instead, and this product's own stock counter is
  // never touched. See inventoryTracking.service.ts.
  inventoryTracking?: InventoryTracking;

  // Absent/undefined behaves as "AUTO" — see RelatedCombo's own comment.
  relatedCombo?: RelatedCombo;

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

const RelatedComboSchema = new Schema<RelatedCombo>(
  {
    mode: { type: String, enum: RELATED_COMBO_MODES, default: "AUTO" },
    comboProductId: { type: Schema.Types.ObjectId, ref: "Product" },
  },
  { _id: false }
);

const ProductSchema = new Schema<ProductDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
    slug: { type: String, required: true, trim: true, unique: true, maxlength: 220 },
    sku: { type: String, required: true, trim: true, unique: true, uppercase: true, maxlength: 64 },
    weightPerPackGrams: { type: Number, min: 0.01, default: null },
    numberOfPacks: { type: Number, min: 1, validate: { validator: (v: number | null) => v == null || Number.isInteger(v), message: "Pack count must be a whole number" }, default: null },
    shortDescription: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, required: true, trim: true, maxlength: 20000 },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true },

    pricing: { type: ProductPricingSchema, required: true },
    inventory: { type: ProductInventorySchema, required: true },
    seo: { type: ProductSeoSchema, required: true },

    // `default: undefined` — same reason Order.model.ts uses it for
    // `payment`/`shipment`/`coupon`: auto-vivifying `{}` here would make
    // `product.packConfig?.enabled` checks meaningless for the millions of
    // products that never configure packs.
    packConfig: { type: ProductPackConfigSchema, default: undefined },

    // `default: undefined` — same reasoning as `packConfig` above.
    inventoryTracking: { type: InventoryTrackingSchema, default: undefined },

    // `default: undefined` — same reasoning as `packConfig` above.
    relatedCombo: { type: RelatedComboSchema, default: undefined },

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
// Backs relatedCombo.service.ts's AUTO lookup — "which ACTIVE, tracking-
// enabled products list this product as a component" — without it, that
// query would have to scan every product's inventoryTracking.components.
ProductSchema.index({ "inventoryTracking.enabled": 1, "inventoryTracking.components.productId": 1 });

export const Product = model<ProductDocument>("Product", ProductSchema);
