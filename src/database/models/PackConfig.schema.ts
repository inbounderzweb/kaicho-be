import { Schema, Types } from "mongoose";

// Shared, embeddable pack/combo configuration used by both Product and
// Category (spec: "Product Configuration > Category Configuration > Global").
// Packs are NOT separate products/collections — they are sub-documents of
// whichever parent (Product or Category) owns them, mutated via atomic
// array ops ($push / positional $set / $pull), the same pattern
// User.addresses uses (see address.service.ts) — never a load-mutate-save
// round trip on the whole parent document.
//
// Deliberately absent from `Pack`: a `stock` / `discount` field.
// - Stock: the pack itself is never a second inventory ledger. Availability
//   for a pack is always derived at read time as
//   `floor(product.inventory.stockQuantity / pack.quantity)` — the base
//   product's `inventory.stockQuantity` remains the single source of truth,
//   which is exactly what makes checkout's existing per-unit `$gte` stock
//   guard and `restoreStockForOrder` (order.service.ts) work unmodified for
//   pack lines (see checkout.service.ts).
// - Discount: derived the same way Product's own discount/discountPercentage
//   are (never stored — see Product.model.ts's header comment and
//   product.service.ts#computeDiscount): `pack.quantity * product.pricing.mrp
//   - pack.price`. Admin sets `price` directly.
export const PACK_RECOMMENDATION_STRATEGIES = [
  "CHEAPEST",
  "LARGEST_FIRST",
  "SMALLEST_FIRST",
  "ADMIN_PRIORITY",
  "MANUAL_ONLY",
] as const;
export type PackRecommendationStrategy = (typeof PACK_RECOMMENDATION_STRATEGIES)[number];

export const PACK_CONFIG_MODES = ["CUSTOM", "INHERIT_CATEGORY"] as const;
export type PackConfigMode = (typeof PACK_CONFIG_MODES)[number];

// One line of a component bill-of-materials: "consuming one unit of
// whatever this is attached to requires `quantity` units of `productId`'s
// own stock." Always references a real, existing Product — never a
// duplicate inventory record (spec §1/§11) and never another pack/combo
// product (spec §12, enforced on save in pack.service.ts/product.service.ts,
// not here — this schema has no way to know a sibling document's own
// config).
export interface InventoryComponent {
  productId: Types.ObjectId;
  quantity: number;
}

export const InventoryComponentSchema = new Schema<InventoryComponent>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

// Attachable at two levels (see InventoryTracking.schema usage in
// Product.model.ts and the `useComponentInventory`/`inventoryComponents`
// fields on Pack below) — both resolve through the same
// inventoryTracking.service.ts#resolveEffectiveComponents fallback: absent
// or disabled means "behave exactly as before this feature existed" (spec
// §9/§10), never a special case downstream.
export interface InventoryTracking {
  enabled: boolean;
  components: InventoryComponent[];
}

export const InventoryTrackingSchema = new Schema<InventoryTracking>(
  {
    enabled: { type: Boolean, default: false },
    components: { type: [InventoryComponentSchema], default: [] },
  },
  { _id: false }
);

export interface Pack {
  _id: Types.ObjectId;
  name: string;
  quantity: number;
  price: number;
  sku?: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  // Per-pack override of the parent product's inventory tracking (or lack
  // of it) — e.g. a pack that bundles several *different* products, not
  // just N more of its own parent. When false/empty, this pack falls back
  // to consuming `quantity` units of its own parent product, exactly as
  // every pack did before this feature existed.
  useComponentInventory: boolean;
  inventoryComponents: InventoryComponent[];
}

export interface PackConfig {
  enabled: boolean;
  mixedPacksAllowed: boolean;
  recommendationStrategy: PackRecommendationStrategy;
  packs: Pack[];
}

// Product's variant adds `mode` (whether this product uses its own packs or
// inherits its category's) — Category has no such field, it IS the source
// a product can inherit from.
export interface ProductPackConfig extends PackConfig {
  mode: PackConfigMode;
}

export const PackSchema = new Schema<Pack>(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    sku: { type: String, trim: true, uppercase: true, maxlength: 64 },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0, min: 0 },
    useComponentInventory: { type: Boolean, default: false },
    inventoryComponents: { type: [InventoryComponentSchema], default: [] },
  },
  { _id: true }
);

export const PackConfigSchema = new Schema<PackConfig>(
  {
    enabled: { type: Boolean, default: false },
    mixedPacksAllowed: { type: Boolean, default: true },
    recommendationStrategy: {
      type: String,
      enum: PACK_RECOMMENDATION_STRATEGIES,
      default: "ADMIN_PRIORITY",
    },
    packs: { type: [PackSchema], default: [] },
  },
  { _id: false }
);

export const ProductPackConfigSchema = new Schema<ProductPackConfig>(
  {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: PACK_CONFIG_MODES, default: "CUSTOM" },
    mixedPacksAllowed: { type: Boolean, default: true },
    recommendationStrategy: {
      type: String,
      enum: PACK_RECOMMENDATION_STRATEGIES,
      default: "ADMIN_PRIORITY",
    },
    packs: { type: [PackSchema], default: [] },
  },
  { _id: false }
);
