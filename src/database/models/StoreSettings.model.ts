import { Schema, model, Document, Types } from "mongoose";
import { PACK_RECOMMENDATION_STRATEGIES, PackRecommendationStrategy } from "./PackConfig.schema";

// Store-wide storefront settings — a SINGLE document, addressed by the fixed
// `key: "store"`. Today it holds only shipping policy (the free-delivery
// threshold and the flat fee charged below it), values that used to be
// hardcoded in checkout.service.ts and the frontend cart. Kept as one
// settings doc rather than a model-per-knob so future storefront settings
// (cashback tiers, COD limits, an announcement bar, …) slot in here without
// new collections or route surface.
export interface StoreSettingsDocument extends Document {
  key: "store";
  freeShippingThreshold: number;
  flatShippingFee: number;
  // The outermost "Global" tier of Product > Category > Global pack config
  // resolution (packCombination.service.ts#resolveEffectivePackConfig) —
  // used only as the strategy fallback when neither a product's nor its
  // category's own config specifies one.
  defaultPackRecommendationStrategy: PackRecommendationStrategy;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// The values a freshly-created settings doc starts from — the same numbers
// the app shipped with before this became configurable. Also used as the
// fallback wherever the doc can't be read.
export const STORE_SETTINGS_DEFAULTS = {
  freeShippingThreshold: 499,
  flatShippingFee: 49,
  defaultPackRecommendationStrategy: "ADMIN_PRIORITY" as PackRecommendationStrategy,
} as const;

const StoreSettingsSchema = new Schema<StoreSettingsDocument>(
  {
    // Unique + enum'd to a single value: the collection can only ever hold
    // one document, and getStoreSettingsDoc()'s upsert keys on it.
    key: { type: String, required: true, unique: true, enum: ["store"], default: "store" },
    freeShippingThreshold: {
      type: Number,
      required: true,
      min: 0,
      default: STORE_SETTINGS_DEFAULTS.freeShippingThreshold,
    },
    flatShippingFee: {
      type: Number,
      required: true,
      min: 0,
      default: STORE_SETTINGS_DEFAULTS.flatShippingFee,
    },
    defaultPackRecommendationStrategy: {
      type: String,
      enum: PACK_RECOMMENDATION_STRATEGIES,
      required: true,
      default: STORE_SETTINGS_DEFAULTS.defaultPackRecommendationStrategy,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const StoreSettings = model<StoreSettingsDocument>("StoreSettings", StoreSettingsSchema);
