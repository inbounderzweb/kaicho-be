import { validateSmartSelection } from "./smartRecommendation.service";
import { AppError } from "../../common/errors";
import { Product, Category, PackConfig } from "../../database/models";
import {
  resolveEffectivePackConfig,
  getApplicablePacks,
  calculateCombinations,
  type PackBreakdownLine,
} from "../product/packCombination.service";
import { resolveLine, type PricedProduct } from "./checkout.service";
import { getDefaultPackRecommendationStrategy } from "../settings/settings.service";
import type { ValidatePackInput, ApplyPackInput } from "./cartPack.validation";

// Backs the two public, unauthenticated endpoints spec §17 asks for
// (POST /cart/validate-pack, POST /cart/apply-pack). Both are advisory only
// — pure reads/recomputation, no stock reservation and no order/cart
// mutation, exactly like previewCheckout — because there IS no persisted
// cart to mutate (the cart lives client-side; see checkout.service.ts's
// header comment). Public because this app lets anonymous shoppers add to
// cart before logging in (decision #6 in the implementation plan), so a
// pack recommendation must be computable pre-login too.

async function loadProductAndCategory(
  productId: string
): Promise<{ product: PricedProduct; category: { packConfig?: PackConfig } | null } | null> {
  const product = await Product.findById(productId)
    .select("name sku status categoryId pricing inventory packConfig inventoryTracking")
    .lean();
  if (!product) return null;

  let category: { packConfig?: PackConfig } | null = null;
  if (product.packConfig?.mode === "INHERIT_CATEGORY") {
    category = await Category.findById(product.categoryId).select("packConfig").lean();
  }

  return { product: product as unknown as PricedProduct, category };
}

export interface PackRecommendation {
  applicable: boolean;
  reason?: string;
  exactMatch?: boolean;
  breakdown?: PackBreakdownLine[];
  totalQuantity?: number;
  totalPrice?: number;
  individualTotal?: number;
  savings?: number;
}

export async function getPackRecommendation(input: ValidatePackInput): Promise<PackRecommendation> {
  const loaded = await loadProductAndCategory(input.productId);
  if (!loaded || loaded.product.status !== "ACTIVE") {
    return { applicable: false, reason: "Product not available" };
  }
  const { product, category } = loaded;

  const defaultStrategy = await getDefaultPackRecommendationStrategy();
  const effective = resolveEffectivePackConfig(product, category, defaultStrategy);
  if (!effective) {
    return { applicable: false, reason: "Pack options are not available for this product" };
  }

  const applicablePacks = getApplicablePacks(effective, input.quantity);
  const result = calculateCombinations(applicablePacks, input.quantity, {
    mixedPacksAllowed: effective.mixedPacksAllowed,
    strategy: effective.recommendationStrategy,
  });
  if (!result) {
    return { applicable: false, reason: "No pack combination matches this quantity" };
  }


  try {
    await validateSmartSelection({ productId: input.productId, quantity: result.totalQuantity, packSelection: result.breakdown.map(p => ({ packId: p.packId, count: p.packCount })) });
  } catch (error) {
    if (error instanceof AppError) return { applicable: false, reason: error.message };
    throw error;
  }

  const individualTotal = Math.round(product.pricing.sellingPrice * 100 * input.quantity) / 100;

  return {
    applicable: true,
    exactMatch: result.exactMatch,
    breakdown: result.breakdown,
    totalQuantity: result.totalQuantity,
    totalPrice: result.totalPrice,
    individualTotal,
    savings: Math.max(0, Math.round((individualTotal - result.totalPrice) * 100) / 100),
  };
}

export interface AppliedPack {
  productId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  breakdown: PackBreakdownLine[];
  availableStock: number | null;
}

// Re-validates a customer-chosen combination and returns its authoritative
// price — the same `resolveLine` checkout.service.ts uses at real checkout,
// so "what apply-pack quotes" and "what checkout actually charges" can never
// drift apart. Never reserves stock (see header comment above).
export async function applyPackSelection(input: ApplyPackInput): Promise<AppliedPack> {
  const loaded = await loadProductAndCategory(input.productId);
  if (!loaded || loaded.product.status !== "ACTIVE") {
    throw new AppError("Product not available", 404);
  }
  const { product, category } = loaded;
  const defaultStrategy = await getDefaultPackRecommendationStrategy();

  const resolved = resolveLine(
    { productId: input.productId, quantity: 0, packSelection: input.packSelection },
    product,
    category,
    defaultStrategy
  );

  await validateSmartSelection({ productId: input.productId, quantity: resolved.quantity, packSelection: input.packSelection });

  return {
    productId: input.productId,
    quantity: resolved.quantity,
    unitPrice: resolved.unitPrice,
    lineTotal: resolved.lineTotal,
    breakdown: (resolved.packBreakdown ?? []).map((line) => ({
      packId: line.packId.toString(),
      packName: line.packName,
      packQuantity: line.packQuantity,
      packCount: line.packCount,
      packPrice: line.packPrice,
    })),
    availableStock: product.inventory.trackInventory ? product.inventory.stockQuantity : null,
  };
}
