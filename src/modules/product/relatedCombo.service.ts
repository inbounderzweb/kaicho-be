import { validateSmartSelection } from "../checkout/smartRecommendation.service";
import { AppError } from "../../common/errors";
import mongoose from "mongoose";
import { Product, ProductDocument, getPinnedComboIds } from "../../database/models";
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
  const pins = product.relatedCombo?.mode === "MANUAL" ? getPinnedComboIds(product.relatedCombo) : [];
  const pinRank = (id: string) => { const i = pins.indexOf(id); return i === -1 ? pins.length : i; };
  candidates.sort((a, b) => pinRank(a._id.toString()) - pinRank(b._id.toString()));
  for (const candidate of candidates) {
    try {
      await validateSmartSelection({ productId: candidate._id.toString(), quantity: 1 });
      return toSuggestion(candidate);
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return null;
}

export interface PinnedComboDto {
  comboProductId: string;
  comboProductName?: string;
  /** Why this pinned bundle is not currently offered to customers, if it isn't. */
  issue?: string;
}

export interface RelatedComboSettingsDto {
  mode: "AUTO" | "MANUAL" | "NONE";
  /** First pinned bundle — kept for older clients; `combos` is the full list. */
  comboProductId?: string;
  /** Display convenience only, so the admin UI doesn't have to show a raw ObjectId for the pinned target. */
  comboProductName?: string;
  /** Every pinned bundle, in admin order. */
  combos: PinnedComboDto[];
  /** Set when MANUAL has nothing pinned. */
  pinnedIssue?: string;
}

// The storefront silently skips a pinned bundle that can't be sold right now
// (inactive, no longer built from this product, or out of stock) and shows
// the others — so the admin needs to be told why.
async function describePinnedIssue(productId: string, combo: { _id: mongoose.Types.ObjectId; status: string; inventoryTracking?: { enabled?: boolean; components: { productId: mongoose.Types.ObjectId }[] } } | undefined): Promise<string | undefined> {
  if (!combo) return "This bundle no longer exists.";
  if (combo.status !== "ACTIVE") return "Not Active, so customers are not offered it.";
  const links = combo.inventoryTracking?.enabled && combo.inventoryTracking.components.some((c) => c.productId.toString() === productId);
  if (!links) return "No longer lists this product in its inventory components.";
  try {
    await validateSmartSelection({ productId: combo._id.toString(), quantity: 1 });
  } catch (error) {
    if (error instanceof AppError) return `Can't be offered right now: ${error.message}`;
    throw error;
  }
  return undefined;
}

export async function toRelatedComboSettingsDto(product: MinimalProduct): Promise<RelatedComboSettingsDto> {
  const mode = product.relatedCombo?.mode ?? "AUTO";
  const ids = getPinnedComboIds(product.relatedCombo);
  const docs = ids.length ? await Product.find({ _id: { $in: ids } }).select("name status inventoryTracking").lean() : [];
  const byId = new Map(docs.map((d) => [d._id.toString(), d]));
  const combos: PinnedComboDto[] = [];
  for (const id of ids) {
    const doc = byId.get(id);
    combos.push({
      comboProductId: id,
      comboProductName: doc?.name,
      issue: mode === "MANUAL" ? await describePinnedIssue(product._id.toString(), doc) : undefined,
    });
  }
  return {
    mode,
    comboProductId: combos[0]?.comboProductId,
    comboProductName: combos[0]?.comboProductName,
    combos,
    pinnedIssue: mode === "MANUAL" && !combos.length ? "No bundle is pinned yet — pick at least one below, otherwise nothing is pinned." : undefined,
  };
}
