import { validateSmartSelection } from "../checkout/smartRecommendation.service";
import { AppError } from "../../common/errors";
import mongoose from "mongoose";
import { Product, ProductDocument } from "../../database/models";
import { computeDiscount, getPrimaryImageUrlMap } from "./product.service";

// "Should this product's PDP offer a bundle/combo instead of (or alongside)
// buying it plain?" — resolved once per product-page load (not per
// Add-to-Cart click, since it doesn't depend on the quantity typed in) and
// embedded in the public product DTO the same way packOptions is.

export interface RelatedComboSuggestion {
  comboProductId: string;
  name: string;
  slug: string;
  image: string | null;
  price: number;
  mrp: number;
  discountPercentage: number;
}

type MinimalProduct = Pick<ProductDocument, "_id" | "relatedCombo">;

async function toSuggestion(comboDoc: {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  pricing: { mrp: number; sellingPrice: number };
}): Promise<RelatedComboSuggestion> {
  const imageUrls = await getPrimaryImageUrlMap([comboDoc._id]);
  const { discountPercentage } = computeDiscount(comboDoc.pricing.mrp, comboDoc.pricing.sellingPrice);
  return {
    comboProductId: comboDoc._id.toString(),
    name: comboDoc.name,
    slug: comboDoc.slug,
    image: imageUrls.get(comboDoc._id.toString()) ?? null,
    price: comboDoc.pricing.sellingPrice,
    mrp: comboDoc.pricing.mrp,
    discountPercentage,
  };
}

// Legacy product DTO support; Add to Cart now uses /cart/recommend for live decisions.
export async function resolveRelatedCombo(product: MinimalProduct): Promise<RelatedComboSuggestion | null> {
  if (product.relatedCombo?.mode === "NONE") return null;
  const candidates = await Product.find({
    _id: { $ne: product._id }, status: "ACTIVE",
    "inventoryTracking.enabled": true,
    "inventoryTracking.components.productId": product._id,
  }).select("name slug pricing sortOrder").sort({ sortOrder: 1, _id: 1 }).lean();
  const pinned = product.relatedCombo?.mode === "MANUAL" ? product.relatedCombo.comboProductId?.toString() : undefined;
  candidates.sort((a, b) => Number(b._id.toString() === pinned) - Number(a._id.toString() === pinned));
  for (const candidate of candidates) {
    try {
      await validateSmartSelection({ productId: candidate._id.toString(), quantity: 1 });
      return toSuggestion(candidate);
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return null;
}

export interface RelatedComboSettingsDto {
  mode: "AUTO" | "MANUAL" | "NONE";
  comboProductId?: string;
  /** Display convenience only, so the admin UI doesn't have to show a raw ObjectId for the pinned target. */
  comboProductName?: string;
}

export async function toRelatedComboSettingsDto(product: MinimalProduct): Promise<RelatedComboSettingsDto> {
  const comboProductId = product.relatedCombo?.comboProductId;
  const comboProductName = comboProductId
    ? (await Product.findById(comboProductId).select("name").lean())?.name
    : undefined;
  return {
    mode: product.relatedCombo?.mode ?? "AUTO",
    comboProductId: comboProductId?.toString(),
    comboProductName,
  };
}
