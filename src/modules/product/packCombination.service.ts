import {
  Pack,
  ProductPackConfig,
  PackConfig,
  PackRecommendationStrategy,
} from "../../database/models";
import { computeDiscount } from "./product.service";

// ---- PackCombinationService ----
// Pure, DB-free functions — every dependency (which packs exist, the
// requested quantity, current stock) is passed in as plain data. This is
// what makes it fully unit-testable in isolation from checkout.service.ts /
// pack.service.ts, per spec §18/§25 ("completely data-driven", "isolated
// from controllers").
//
// Hard bound: no caller may ask for a combination above MAX_COMBINATION_QUANTITY.
// The DP below is O(quantity * packCount) — bounding quantity is what keeps
// "don't hard-code quantity limits" (spec §5) safe rather than unbounded.
// checkout.validation.ts's per-line quantity cap uses the same constant.
export const MAX_COMBINATION_QUANTITY = 100_000;

export interface CandidatePack {
  packId: string;
  name: string;
  quantity: number;
  price: number;
  sortOrder: number;
  isDefault: boolean;
}

export interface PackBreakdownLine {
  packId: string;
  packName: string;
  packQuantity: number;
  packCount: number;
  packPrice: number;
}

export interface PackCombinationResult {
  breakdown: PackBreakdownLine[];
  totalQuantity: number;
  totalPrice: number;
  /** true for the trivial "requested quantity exactly equals one configured pack" case. */
  exactMatch: boolean;
}

export interface EffectivePackConfig {
  source: "PRODUCT" | "CATEGORY";
  mixedPacksAllowed: boolean;
  recommendationStrategy: PackRecommendationStrategy;
  packs: Pack[];
}

// Product > Category > (disabled). A product must explicitly opt in
// (`packConfig.enabled`) — an untouched product (packConfig undefined, the
// state of every product that existed before this feature) always resolves
// to `null`, i.e. "behave exactly as today" (spec §22).
export function resolveEffectivePackConfig(
  product: { packConfig?: ProductPackConfig },
  category: { packConfig?: PackConfig } | null | undefined,
  globalDefaultStrategy: PackRecommendationStrategy
): EffectivePackConfig | null {
  const productConfig = product.packConfig;
  if (!productConfig?.enabled) return null;

  if (productConfig.mode === "INHERIT_CATEGORY") {
    const categoryConfig = category?.packConfig;
    if (!categoryConfig?.enabled) return null;
    return {
      source: "CATEGORY",
      mixedPacksAllowed: categoryConfig.mixedPacksAllowed,
      recommendationStrategy: categoryConfig.recommendationStrategy ?? globalDefaultStrategy,
      packs: categoryConfig.packs,
    };
  }

  return {
    source: "PRODUCT",
    mixedPacksAllowed: productConfig.mixedPacksAllowed,
    recommendationStrategy: productConfig.recommendationStrategy ?? globalDefaultStrategy,
    packs: productConfig.packs,
  };
}

// Active packs only (spec §19 "disabled pack"), mapped to the DP's plain
// input shape. When `quantity` is given, packs individually larger than it
// are dropped — they can never participate in a combination that sums to
// exactly `quantity`.
export function getApplicablePacks(config: EffectivePackConfig, quantity?: number): CandidatePack[] {
  return config.packs
    .filter((p) => p.isActive)
    .filter((p) => quantity === undefined || p.quantity <= quantity)
    .map((p) => ({
      packId: p._id.toString(),
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      sortOrder: p.sortOrder,
      isDefault: p.isDefault,
    }));
}

function priorityOrderFor(
  packs: CandidatePack[],
  strategy: PackRecommendationStrategy
): number[] {
  const indices = packs.map((_, i) => i);
  switch (strategy) {
    case "LARGEST_FIRST":
      return indices.sort((a, b) => packs[b].quantity - packs[a].quantity);
    case "SMALLEST_FIRST":
      return indices.sort((a, b) => packs[a].quantity - packs[b].quantity);
    case "ADMIN_PRIORITY":
    case "MANUAL_ONLY":
    case "CHEAPEST":
    default:
      return indices.sort((a, b) => packs[a].sortOrder - packs[b].sortOrder);
  }
}

// Unbounded "coin combination" DP: for every amount 0..quantity, tracks the
// best way to reach it exactly using any number of copies of any candidate
// pack. `objective` picks what "best" means:
//  - MIN_PRICE (CHEAPEST strategy): minimise total rupees.
//  - MIN_COUNT (every other auto strategy): minimise the number of packs
//    used — which is what naturally produces spec §5/§8's own worked
//    example (50 -> 20x2 + 10x1 is the 3-pack minimum for {5,10,20}).
// Ties are broken by `priorityOrder` (earlier = more preferred), so
// LARGEST_FIRST/SMALLEST_FIRST/ADMIN_PRIORITY differ only in that ordering.
function findBestCombination(
  packs: CandidatePack[],
  quantity: number,
  objective: "MIN_PRICE" | "MIN_COUNT",
  priorityOrder: number[]
): PackBreakdownLine[] | null {
  if (packs.length === 0 || quantity <= 0) return null;

  const INF = Infinity;
  const cost = new Array<number>(quantity + 1).fill(INF);
  const packsUsed = new Array<number>(quantity + 1).fill(INF);
  const lastPackIdx = new Array<number>(quantity + 1).fill(-1);
  cost[0] = 0;
  packsUsed[0] = 0;

  const rank = new Map<number, number>();
  priorityOrder.forEach((packIdx, order) => rank.set(packIdx, order));
  const rankOf = (packIdx: number) => rank.get(packIdx) ?? packs.length;

  for (let amount = 1; amount <= quantity; amount++) {
    for (let i = 0; i < packs.length; i++) {
      const pack = packs[i];
      if (pack.quantity > amount) continue;
      const prev = amount - pack.quantity;
      if (cost[prev] === INF) continue;

      const candidateCost = objective === "MIN_PRICE" ? cost[prev] + pack.price : cost[prev] + 1;
      const candidateCount = packsUsed[prev] + 1;

      let better = false;
      if (candidateCost < cost[amount]) {
        better = true;
      } else if (candidateCost === cost[amount]) {
        if (candidateCount < packsUsed[amount]) {
          better = true;
        } else if (candidateCount === packsUsed[amount]) {
          const currentLast = lastPackIdx[amount];
          if (currentLast === -1 || rankOf(i) < rankOf(currentLast)) {
            better = true;
          }
        }
      }

      if (better) {
        cost[amount] = candidateCost;
        packsUsed[amount] = candidateCount;
        lastPackIdx[amount] = i;
      }
    }
  }

  if (cost[quantity] === INF) return null;

  const countsByPackIdx = new Map<number, number>();
  let remaining = quantity;
  while (remaining > 0) {
    const idx = lastPackIdx[remaining];
    if (idx === -1) return null;
    countsByPackIdx.set(idx, (countsByPackIdx.get(idx) ?? 0) + 1);
    remaining -= packs[idx].quantity;
  }

  return [...countsByPackIdx.entries()]
    .sort(([a], [b]) => rankOf(a) - rankOf(b))
    .map(([idx, count]) => ({
      packId: packs[idx].packId,
      packName: packs[idx].name,
      packQuantity: packs[idx].quantity,
      packCount: count,
      packPrice: packs[idx].price,
    }));
}

// "Mixed packs: NO" (spec §9) — only a combination using a single pack size
// repeated N times qualifies (quantity must be an exact multiple of one
// configured pack's size). Picks among the valid single-size options the
// same way findBestCombination would (cheapest, or priority-order).
function findBestSinglePackSolution(
  packs: CandidatePack[],
  quantity: number,
  objective: "MIN_PRICE" | "MIN_COUNT",
  priorityOrder: number[]
): PackBreakdownLine[] | null {
  const rank = new Map<number, number>();
  priorityOrder.forEach((packIdx, order) => rank.set(packIdx, order));

  let best: { idx: number; count: number; price: number } | null = null;
  for (let i = 0; i < packs.length; i++) {
    const pack = packs[i];
    if (pack.quantity <= 0 || quantity % pack.quantity !== 0) continue;
    const count = quantity / pack.quantity;
    const price = count * pack.price;
    if (!best) {
      best = { idx: i, count, price };
      continue;
    }
    const better =
      objective === "MIN_PRICE"
        ? price < best.price ||
          (price === best.price && (rank.get(i) ?? packs.length) < (rank.get(best.idx) ?? packs.length))
        : count < best.count ||
          (count === best.count && (rank.get(i) ?? packs.length) < (rank.get(best.idx) ?? packs.length));
    if (better) best = { idx: i, count, price };
  }

  if (!best) return null;
  const pack = packs[best.idx];
  return [
    {
      packId: pack.packId,
      packName: pack.name,
      packQuantity: pack.quantity,
      packCount: best.count,
      packPrice: pack.price,
    },
  ];
}

export interface CalculateCombinationsOptions {
  mixedPacksAllowed: boolean;
  strategy: PackRecommendationStrategy;
}

// The engine's single entry point. Returns `null` whenever no recommendation
// should be shown (spec §19's "no valid combination" and "below minimum
// pack" cases) — callers fall back to plain individual-unit pricing, exactly
// as if packs were never configured for this line.
export function calculateCombinations(
  activePacks: CandidatePack[],
  quantity: number,
  options: CalculateCombinationsOptions
): PackCombinationResult | null {
  if (quantity <= 0 || quantity > MAX_COMBINATION_QUANTITY || activePacks.length === 0) return null;

  // An exact 1:1 match is always offered, regardless of strategy or the
  // mixed-packs setting (spec §4) — including MANUAL_ONLY (decision #7),
  // which otherwise never auto-combines.
  const exact = activePacks.find((p) => p.quantity === quantity);
  if (exact) {
    return {
      breakdown: [
        {
          packId: exact.packId,
          packName: exact.name,
          packQuantity: exact.quantity,
          packCount: 1,
          packPrice: exact.price,
        },
      ],
      totalQuantity: quantity,
      totalPrice: exact.price,
      exactMatch: true,
    };
  }

  if (options.strategy === "MANUAL_ONLY") return null;

  const objective: "MIN_PRICE" | "MIN_COUNT" = options.strategy === "CHEAPEST" ? "MIN_PRICE" : "MIN_COUNT";
  const priorityOrder = priorityOrderFor(activePacks, options.strategy);

  const breakdown = options.mixedPacksAllowed
    ? findBestCombination(activePacks, quantity, objective, priorityOrder)
    : findBestSinglePackSolution(activePacks, quantity, objective, priorityOrder);

  if (!breakdown) return null;

  return {
    breakdown,
    totalQuantity: quantity,
    totalPrice: calculatePackPrice(breakdown),
    exactMatch: false,
  };
}

export function calculatePackPrice(breakdown: PackBreakdownLine[]): number {
  const minor = breakdown.reduce((sum, line) => sum + Math.round(line.packPrice * 100) * line.packCount, 0);
  return minor / 100;
}

export function validateStock(result: PackCombinationResult, availableStock: number): boolean {
  return result.totalQuantity <= availableStock;
}

// Per-pack display helper for admin/customer read paths — mirrors
// product.service.ts#computeDiscount exactly (derived, never stored; see
// PackConfig.schema.ts's header comment for why).
export function computePackDiscount(pack: Pack, productMrp: number): { discount: number; discountPercentage: number } {
  return computeDiscount(pack.quantity * productMrp, pack.price);
}

// Availability shown to admin/customer for a pack — always derived from the
// base product's real stock, never a second counter (decision #1).
export function computePackAvailability(pack: Pack, productStockQuantity: number): number {
  if (pack.quantity <= 0) return 0;
  return Math.floor(productStockQuantity / pack.quantity);
}
