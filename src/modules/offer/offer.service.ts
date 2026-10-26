import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Category, Media, Offer, OfferDocument, OfferUsage, Order, OrderOffer, OfferStatus, Product } from "../../database/models";
import { getStorageProvider } from "../media/storage";
import {
  computeAutoAllocation,
  computeDiscountAllocation,
  computeMappedAutoAllocation,
  computeMappedSelectionAllocation,
  computeRoleAutoAllocation,
  computeRoleSelectionAllocation,
  computeSelectionAllocation,
  type DiscountRule,
  type EngineLine,
  type EngineResult,
  type MappedLine,
  type OfferEngineRule,
  type RejectedSelection,
  type RoleLine,
} from "./offerEngine";

// The offer domain layer. Imports only models + AppError + the pure engine —
// it is imported BY checkout.service / order.service, so it must not import
// either of them back (no cycles). Same shape and constraints as
// coupon.service.ts: no MongoDB transactions, so consume/release use atomic
// conditional updates, unique-index collisions and compensating writes.

type OfferWindow = Pick<OfferDocument, "status" | "startsAt" | "endsAt">;

/** Stored status folded with the current time window. */
export function getEffectiveOfferStatus(offer: OfferWindow, now: Date = new Date()): OfferStatus {
  if (offer.status !== "ACTIVE") return offer.status;
  if (offer.startsAt && offer.startsAt.getTime() > now.getTime()) return "SCHEDULED";
  if (offer.endsAt && offer.endsAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

// ---- Banner image ----

export interface OfferImageInfo {
  mediaId: string;
  url: string;
  thumbnailUrl?: string;
}

/** Batch-resolves banner media ids to URLs — one query, never per offer. */
export async function loadOfferImageMap(mediaIds: unknown[]): Promise<Map<string, OfferImageInfo>> {
  const ids = [...new Set(mediaIds.filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const storage = getStorageProvider();
  const docs = await Media.find({ _id: { $in: ids } }).exec();
  return new Map(
    docs.map((m) => {
      const optimizedKey = m.variants ? m.variants.optimized.key : m.storageKey;
      return [
        m._id.toString(),
        {
          mediaId: m._id.toString(),
          url: storage.getUrl(optimizedKey),
          thumbnailUrl: m.variants ? storage.getUrl(m.variants.thumbnail.key) : undefined,
        },
      ] as const;
    })
  );
}

// ---- Eligibility ----

export interface OfferScope {
  applyToAll: boolean;
  productIds: Set<string>;
  /** BOGO: products that may be given free (empty = legacy pooled offer). */
  freeProductIds: Set<string>;
  /** MAPPED BOGO: bought product -> the products it may earn free. */
  freeRules: Map<string, Set<string>>;
  /** MAPPED BOGO: free products for a bought product with no rule of its own. */
  freeFallback: Set<string>;
  categoryIds: Set<string>;
  excludedProductIds: Set<string>;
  excludedCategoryIds: Set<string>;
}

type ScopeSource = Pick<
  OfferDocument,
  "applyToAll" | "eligibleProductIds" | "eligibleCategoryIds" | "excludedProductIds" | "excludedCategoryIds"
> & { freeProductIds?: OfferDocument["freeProductIds"]; freeProductRules?: OfferDocument["freeProductRules"] };

/** categoryId -> itself plus every descendant, from ONE query over the (tiny) category tree. */
async function loadDescendantsMap(categoryIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (categoryIds.length === 0) return result;
  const all = await Category.find({}).select("parentId").lean();
  const childrenOf = new Map<string, string[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const parent = c.parentId.toString();
    const list = childrenOf.get(parent) ?? [];
    list.push(c._id.toString());
    childrenOf.set(parent, list);
  }
  for (const root of categoryIds) {
    const seen = new Set<string>([root]);
    const queue = [root];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    result.set(root, [...seen]);
  }
  return result;
}

function buildScope(offer: ScopeSource, descendants: Map<string, string[]>): OfferScope {
  const expand = (ids: unknown[]) => {
    const out = new Set<string>();
    for (const id of ids) {
      const key = String(id);
      for (const d of descendants.get(key) ?? [key]) out.add(d);
    }
    return out;
  };
  return {
    // "All products" is no longer a supported scope: an offer only ever covers
    // the products/categories explicitly selected (legacy applyToAll offers
    // stop matching everything and fall back to their explicit lists).
    applyToAll: false,
    productIds: new Set(offer.eligibleProductIds.map(String)),
    // MAPPED offers can give away anything any rule names, plus the fallback list.
    freeProductIds: new Set([
      ...(offer.freeProductIds ?? []).map(String),
      ...(offer.freeProductRules ?? []).flatMap((r) => r.freeProductIds.map(String)),
    ]),
    freeRules: new Map((offer.freeProductRules ?? []).map((r) => [String(r.buyProductId), new Set(r.freeProductIds.map(String))])),
    freeFallback: new Set((offer.freeProductIds ?? []).map(String)),
    // Offers cover only explicitly selected PRODUCTS. Eligible categories are
    // ignored (legacy data), so a category can never blanket-badge the catalog.
    categoryIds: new Set<string>(),
    excludedProductIds: new Set(offer.excludedProductIds.map(String)),
    excludedCategoryIds: expand(offer.excludedCategoryIds),
  };
}

/** Exclusions always win; otherwise explicit inclusion is required. */
export function isProductEligible(scope: OfferScope, productId: string, categoryId: string): boolean {
  if (scope.excludedProductIds.has(productId) || scope.excludedCategoryIds.has(categoryId)) return false;
  return scope.applyToAll || scope.productIds.has(productId) || scope.categoryIds.has(categoryId);
}

/** Can this product be handed out free by the offer? Exclusions still win. */
export function isProductFreeCandidate(scope: OfferScope, productId: string, categoryId: string): boolean {
  if (scope.excludedProductIds.has(productId) || scope.excludedCategoryIds.has(categoryId)) return false;
  return scope.freeProductIds.has(productId);
}

/**
 * How the offer is evaluated:
 *  - PERCENTAGE / FIXED : a discount on every unit of the eligible products
 *  - BOGO_POOL          : legacy Buy X Get 1 — the eligible products are both bought and free (the
 *                         free unit never costs more than the unit it is paired with). Used by offers
 *                         made before free products existed, and when the free list equals the eligible list.
 *  - BOGO_ROLES         : buy from the eligible list, receive a unit from the (different) free list
 *  - BOGO_MAPPED        : per-product rules (buy A -> free B or C), free never costs more than bought
 */
export type OfferMode = "PERCENTAGE" | "FIXED" | "BOGO_POOL" | "BOGO_ROLES" | "BOGO_MAPPED";

export function getOfferMode(offer: {
  type: OfferDocument["type"];
  eligibleProductIds: unknown[];
  freeProductIds?: unknown[];
  freeProductRules?: unknown[];
}): OfferMode {
  if (offer.type === "PERCENTAGE") return "PERCENTAGE";
  if (offer.type === "FIXED") return "FIXED";
  if ((offer.freeProductRules?.length ?? 0) > 0) return "BOGO_MAPPED";
  const free = new Set((offer.freeProductIds ?? []).map(String));
  if (free.size === 0) return "BOGO_POOL";
  const eligible = new Set(offer.eligibleProductIds.map(String));
  const same = free.size === eligible.size && [...free].every((id) => eligible.has(id));
  return same ? "BOGO_POOL" : "BOGO_ROLES";
}

/** Scope for ONE offer (admin simulator). Checkout/storefront build many at once via a shared descendants map. */
export async function buildScopeForOffer(offer: ScopeSource): Promise<OfferScope> {
  const descendants = await loadDescendantsMap([
    ...new Set([...offer.eligibleCategoryIds, ...offer.excludedCategoryIds].map(String)),
  ]);
  return buildScope(offer, descendants);
}

// ---- Loading ----

function liveFilter(now: Date) {
  return {
    status: "ACTIVE" as const,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
    ],
  };
}

export async function loadLiveOffers(now: Date = new Date()) {
  return Offer.find(liveFilter(now)).sort({ createdAt: 1 }).lean();
}

type LiveOffer = Awaited<ReturnType<typeof loadLiveOffers>>[number];

// ---- Evaluation ----

export interface OfferCartLine {
  productId: string;
  categoryId: string;
  /** Applicable selling price in rupees, read from the DB (never the client). */
  unitPrice: number;
  quantity: number;
}

export interface FreeSelection {
  productId: string;
  quantity: number;
}

export interface EvaluatedOffer {
  offerId: string;
  /** The offer's customer-facing title. */
  name: string;
  type: OfferDocument["type"];
  mode: OfferMode;
  /** PERCENTAGE offers. */
  discountPercent: number | null;
  /** FIXED offers: rupees off each unit. */
  discountAmountPerUnit: number | null;
  description: string | null;
  buyQuantity: number;
  maxFreeUnitsPerOrder: number;
  minPaidUnitPrice: number;
  allowCouponStacking: boolean;
  /** Cart products this offer covers (eligible, active, in stock). */
  eligibleProductIds: string[];
  /** BOGO: products configured as free (empty on legacy offers). */
  freeProductIds: string[];
  /** BOGO: cart products the shopper may pick as their free item. */
  freeCandidateProductIds: string[];
  /** BOGO with a separate free list: nothing from that list is in the cart yet. */
  needsFreeProduct: boolean;
  /** productId -> rupees taken off that product's whole line (BOGO: the free units' price). */
  discountByProduct: Map<string, number>;
  /** Rupees off. 0 when the offer is live but nothing qualified yet. */
  discountAmount: number;
  freeUnits: number;
  freeByProduct: Map<string, number>;
  pairs: EngineResult["pairs"];
  rejected: RejectedSelection[];
  limitReached: boolean;
  unitsToNextFree: number;
  /**
   * BOGO (pooled and mapped): the cart's paid units that can still earn a free
   * item — price, quantity and which products each may earn. The checkout layer
   * turns these into price-limited suggestions. Units already given free are excluded.
   */
  payerGroups: { productId: string; unitPriceMinor: number; quantity: number; allowedFree: string[] }[];
  /** Rule snapshot source, used when persisting Order.offer. */
  rules: {
    applyToAll: boolean;
    eligibleProductIds: string[];
    eligibleCategoryIds: string[];
    excludedProductIds: string[];
    excludedCategoryIds: string[];
    freeProductIds: string[];
  };
}

function toEngineRule(offer: LiveOffer): OfferEngineRule {
  return {
    buyQuantity: offer.buyQuantity,
    maxFreeUnitsPerOrder: offer.maxFreeUnitsPerOrder,
    minPaidUnitPriceMinor: Math.round((offer.minPaidUnitPrice ?? 0) * 100),
  };
}

/** Advisory usage-limit check (the authoritative one is consumeOfferForOrder). */
async function isOfferExhaustedForUser(offer: LiveOffer, userId: string | null): Promise<boolean> {
  if (offer.usageLimit != null && offer.usedCount >= offer.usageLimit) return true;
  if (offer.usageLimitPerUser != null && userId) {
    const used = await OfferUsage.countDocuments({
      offerId: offer._id,
      userId: new mongoose.Types.ObjectId(userId),
    });
    if (used >= offer.usageLimitPerUser) return true;
  }
  return false;
}

export function evaluateOfferAgainstLines(
  offer: LiveOffer,
  scope: OfferScope,
  lines: OfferCartLine[],
  selection?: FreeSelection[]
): EvaluatedOffer {
  const mode = getOfferMode(offer);
  const rule = toEngineRule(offer);
  const priceMinor = new Map<string, number>();
  for (const l of lines) priceMinor.set(l.productId, Math.round(l.unitPrice * 100));

  const eligibleLines: EngineLine[] = lines
    .filter((l) => l.quantity > 0 && isProductEligible(scope, l.productId, l.categoryId))
    .map((l) => ({ productId: l.productId, unitPriceMinor: Math.round(l.unitPrice * 100), quantity: l.quantity }));
  const eligibleIds = new Set(eligibleLines.map((l) => l.productId));

  let result: EngineResult;
  let discountMinorByProduct = new Map<string, number>();
  let freeCandidateIds: string[] = [];
  let mappedPayers: EvaluatedOffer["payerGroups"] = [];

  // "I'll choose" with nothing actually picked is the same as no preference:
  // the best automatic allocation applies. Treating an empty list as "the
  // customer wants no free item" would silently charge them for everything.
  const picks = selection?.filter((s) => s.quantity > 0);

  if (mode === "PERCENTAGE" || mode === "FIXED") {
    const discountRule: DiscountRule =
      mode === "PERCENTAGE"
        ? { kind: "PERCENTAGE", percent: offer.discountPercent ?? 0 }
        : { kind: "FIXED", amountMinor: Math.round((offer.discountAmount ?? 0) * 100) };
    const allocation = computeDiscountAllocation(eligibleLines, discountRule);
    discountMinorByProduct = allocation.discountMinorByProduct;
    result = {
      freeByProduct: new Map(),
      freeUnits: 0,
      discountMinor: allocation.discountMinor,
      pairs: [],
      rejected: [],
      limitReached: false,
      unitsToNextFree: 0,
      needsFreeProduct: false,
    };
  } else if (mode === "BOGO_MAPPED") {
    const mappedLines: MappedLine[] = lines
      .filter((l) => l.quantity > 0)
      .map((l) => ({
        productId: l.productId,
        unitPriceMinor: Math.round(l.unitPrice * 100),
        quantity: l.quantity,
        canPay: isProductEligible(scope, l.productId, l.categoryId),
        canFree: isProductFreeCandidate(scope, l.productId, l.categoryId),
        allowedFree: scope.freeRules.get(l.productId) ?? scope.freeFallback,
      }))
      .filter((l) => l.canPay || l.canFree);
    freeCandidateIds = mappedLines.filter((l) => l.canFree).map((l) => l.productId);
    mappedPayers = mappedLines
      .filter((l) => l.canPay && l.unitPriceMinor >= rule.minPaidUnitPriceMinor)
      .map((l) => ({ productId: l.productId, unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, allowedFree: [...l.allowedFree] }));
    result = picks && picks.length > 0 ? computeMappedSelectionAllocation(mappedLines, picks, rule) : computeMappedAutoAllocation(mappedLines, rule);
  } else if (mode === "BOGO_ROLES") {
    const roleLines: RoleLine[] = lines
      .filter((l) => l.quantity > 0)
      .map((l) => ({
        productId: l.productId,
        unitPriceMinor: Math.round(l.unitPrice * 100),
        quantity: l.quantity,
        canPay: isProductEligible(scope, l.productId, l.categoryId),
        canFree: isProductFreeCandidate(scope, l.productId, l.categoryId),
      }))
      .filter((l) => l.canPay || l.canFree);
    freeCandidateIds = roleLines.filter((l) => l.canFree).map((l) => l.productId);
    const candidateSet = new Set(freeCandidateIds);

    if (picks && picks.length > 0) {
      const covered = picks.filter((s) => candidateSet.has(s.productId));
      result = computeRoleSelectionAllocation(roleLines, covered, rule);
      for (const s of picks) {
        if (!candidateSet.has(s.productId)) {
          result.rejected.push({
            productId: s.productId,
            quantity: s.quantity,
            reason: "NOT_ELIGIBLE",
            message: "This item isn't one of the free items for this offer.",
          });
        }
      }
    } else {
      result = computeRoleAutoAllocation(roleLines, rule);
    }
  } else {
    // Legacy pooled BOGO.
    freeCandidateIds = [...eligibleIds];
    // In a pooled offer every eligible product may be bought and every eligible
    // product given free, subject only to the price rule.
    mappedPayers = eligibleLines
      .filter((l) => l.unitPriceMinor >= rule.minPaidUnitPriceMinor)
      .map((l) => ({ productId: l.productId, unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, allowedFree: [...scope.productIds] }));
    if (picks && picks.length > 0) {
      // Picks for a product this offer doesn't cover are reported, not dropped.
      const covered = picks.filter((s) => eligibleIds.has(s.productId));
      result = computeSelectionAllocation(eligibleLines, covered, rule);
      for (const s of picks) {
        if (!eligibleIds.has(s.productId)) {
          result.rejected.push({
            productId: s.productId,
            quantity: s.quantity,
            reason: "NOT_ELIGIBLE",
            message: "This item doesn't qualify for the offer.",
          });
        }
      }
    } else {
      result = computeAutoAllocation(eligibleLines, rule);
    }
  }

  if (mode === "BOGO_POOL" || mode === "BOGO_ROLES" || mode === "BOGO_MAPPED") {
    // A free unit takes its own unit price off; the line it belongs to keeps its full total.
    for (const [productId, qty] of result.freeByProduct) {
      discountMinorByProduct.set(productId, (priceMinor.get(productId) ?? 0) * qty);
    }
  }

  // A unit already given free is not a paid partner for another free item.
  mappedPayers = mappedPayers
    .map((g) => ({ ...g, quantity: g.quantity - (result.freeByProduct.get(g.productId) ?? 0) }))
    .filter((g) => g.quantity > 0);

  const coveredIds = mode === "BOGO_ROLES" || mode === "BOGO_MAPPED" ? new Set([...eligibleIds, ...freeCandidateIds]) : eligibleIds;

  return {
    offerId: offer._id.toString(),
    name: offer.name,
    type: offer.type,
    mode,
    discountPercent: mode === "PERCENTAGE" ? offer.discountPercent ?? null : null,
    discountAmountPerUnit: mode === "FIXED" ? offer.discountAmount ?? null : null,
    description: offer.description ?? null,
    buyQuantity: offer.buyQuantity,
    maxFreeUnitsPerOrder: offer.maxFreeUnitsPerOrder,
    minPaidUnitPrice: offer.minPaidUnitPrice ?? 0,
    allowCouponStacking: offer.allowCouponStacking ?? false,
    eligibleProductIds: [...coveredIds],
    freeProductIds: mode === "BOGO_MAPPED" ? [...scope.freeProductIds] : (offer.freeProductIds ?? []).map(String),
    freeCandidateProductIds: freeCandidateIds,
    needsFreeProduct: result.needsFreeProduct,
    discountByProduct: new Map([...discountMinorByProduct].map(([id, minor]) => [id, minor / 100])),
    discountAmount: result.discountMinor / 100,
    freeUnits: result.freeUnits,
    freeByProduct: result.freeByProduct,
    pairs: result.pairs,
    rejected: result.rejected,
    limitReached: result.limitReached,
    unitsToNextFree: result.unitsToNextFree,
    payerGroups: mappedPayers,
    rules: {
      applyToAll: offer.applyToAll,
      eligibleProductIds: offer.eligibleProductIds.map(String),
      eligibleCategoryIds: offer.eligibleCategoryIds.map(String),
      excludedProductIds: offer.excludedProductIds.map(String),
      excludedCategoryIds: offer.excludedCategoryIds.map(String),
      freeProductIds: (offer.freeProductIds ?? []).map(String),
    },
  };
}

/**
 * Picks the live offer that saves the customer the most (ties: oldest offer,
 * so the result is deterministic). Only ONE offer ever applies to an order —
 * a unit can't be free twice. Returns null when no live offer has anything to
 * say about this cart. The result may have discountAmount 0 (offer is live
 * and relevant, e.g. "add 1 more to get one free", or the customer's picks
 * were rejected) — callers apply it only when discountAmount > 0.
 *
 * `lines` must already be limited to ACTIVE, in-stock UNIT lines priced from
 * the database; this function trusts them completely.
 */
export async function evaluateBestOffer(params: {
  userId: string | null;
  lines: OfferCartLine[];
  selection?: FreeSelection[];
  now?: Date;
}): Promise<EvaluatedOffer | null> {
  if (params.lines.length === 0) return null;
  const offers = await loadLiveOffers(params.now);
  if (offers.length === 0) return null;

  const descendants = await loadDescendantsMap([
    ...new Set(offers.flatMap((o) => [...o.eligibleCategoryIds, ...o.excludedCategoryIds].map(String))),
  ]);

  let best: EvaluatedOffer | null = null;
  for (const offer of offers) {
    const scope = buildScope(offer, descendants);
    const touches = params.lines.some(
      (l) => isProductEligible(scope, l.productId, l.categoryId) || isProductFreeCandidate(scope, l.productId, l.categoryId)
    );
    if (!touches) continue;
    if (await isOfferExhaustedForUser(offer, params.userId)) continue;

    const evaluated = evaluateOfferAgainstLines(offer, scope, params.lines, params.selection);
    const better =
      !best ||
      evaluated.discountAmount > best.discountAmount ||
      (evaluated.discountAmount === best.discountAmount &&
        best.discountAmount === 0 &&
        (evaluated.rejected.length > best.rejected.length ||
          (evaluated.rejected.length === best.rejected.length && evaluated.unitsToNextFree < best.unitsToNextFree)));
    if (better) best = evaluated;
  }
  return best;
}

// ---- Order snapshot ----

export interface SnapshotLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export function toOrderOfferSnapshot(
  evaluated: EvaluatedOffer,
  freeItems: SnapshotLine[],
  /** PERCENTAGE / FIXED offers: every discounted line (quantity = units on the line). */
  discountedItems: SnapshotLine[] = []
): OrderOffer {
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const isDiscountType = evaluated.type === "PERCENTAGE" || evaluated.type === "FIXED";
  return {
    offerId: oid(evaluated.offerId),
    name: evaluated.name,
    type: evaluated.type,
    ...(evaluated.discountPercent != null ? { discountPercent: evaluated.discountPercent } : {}),
    ...(evaluated.discountAmountPerUnit != null ? { discountAmountPerUnit: evaluated.discountAmountPerUnit } : {}),
    ...(isDiscountType
      ? {
          discountedItems: discountedItems.map((d) => ({
            productId: oid(d.productId),
            sku: d.sku,
            name: d.name,
            quantity: d.quantity,
            unitPrice: d.unitPrice,
            discount: evaluated.discountByProduct.get(d.productId) ?? 0,
          })),
        }
      : {}),
    buyQuantity: evaluated.buyQuantity,
    maxFreeUnitsPerOrder: evaluated.maxFreeUnitsPerOrder,
    minPaidUnitPrice: evaluated.minPaidUnitPrice,
    allowCouponStacking: evaluated.allowCouponStacking,
    freeUnits: evaluated.freeUnits,
    discountAmount: evaluated.discountAmount,
    freeItems: freeItems.map((f) => ({
      productId: oid(f.productId),
      sku: f.sku,
      name: f.name,
      quantity: f.quantity,
      unitPrice: f.unitPrice,
      discount: Math.round(f.unitPrice * 100) * f.quantity / 100,
    })),
    pairs: evaluated.pairs.map((p) => ({
      freeProductId: oid(p.freeProductId),
      freeUnitPrice: p.freeUnitPriceMinor / 100,
      paid: p.paid.map((u) => ({
        productId: oid(u.productId),
        unitPrice: u.unitPriceMinor / 100,
        quantity: u.quantity,
      })),
      count: p.count,
    })),
    rules: {
      applyToAll: evaluated.rules.applyToAll,
      eligibleProductIds: evaluated.rules.eligibleProductIds.map(oid),
      eligibleCategoryIds: evaluated.rules.eligibleCategoryIds.map(oid),
      excludedProductIds: evaluated.rules.excludedProductIds.map(oid),
      excludedCategoryIds: evaluated.rules.excludedCategoryIds.map(oid),
      ...(evaluated.rules.freeProductIds.length > 0 ? { freeProductIds: evaluated.rules.freeProductIds.map(oid) } : {}),
    },
  };
}

// ---- Consumption (race-safe, no transactions) ----

function isDuplicateKeyError(err: unknown, field: string): boolean {
  const candidate = err as { code?: number; keyPattern?: Record<string, unknown> };
  return candidate?.code === 11000 && Boolean(candidate.keyPattern && field in candidate.keyPattern);
}

const PER_USER_SEQ_ATTEMPTS = 5;

/**
 * Records one redemption of the offer for an already-created order. Same
 * two-step protocol as consumeCouponForOrder: insert the OfferUsage row first
 * (its unique indexes serialise per-user races and make a retry a no-op),
 * then claim a global slot with an atomic limit-guarded $inc, undoing the row
 * if that guard fails. Throws AppError(409) on any "no longer available"
 * outcome; the caller then deletes the order and releases stock.
 */
export async function consumeOfferForOrder(params: {
  offerId: string;
  userId: string;
  order: { _id: mongoose.Types.ObjectId | string; orderNumber: string };
  freeUnits: number;
  discountAmount: number;
}): Promise<void> {
  const offer = await Offer.findById(params.offerId).lean();
  if (!offer || getEffectiveOfferStatus(offer) !== "ACTIVE") {
    throw new AppError("This offer is no longer available.", 409);
  }

  const userId = new mongoose.Types.ObjectId(params.userId);
  const orderId =
    typeof params.order._id === "string" ? new mongoose.Types.ObjectId(params.order._id) : params.order._id;

  let created = false;
  for (let attempt = 0; attempt < PER_USER_SEQ_ATTEMPTS && !created; attempt++) {
    const usedByUser = await OfferUsage.countDocuments({ offerId: offer._id, userId });
    const seq = usedByUser + 1;
    if (offer.usageLimitPerUser != null && seq > offer.usageLimitPerUser) {
      throw new AppError("You've already used this offer the maximum number of times.", 409);
    }
    try {
      await OfferUsage.create({
        offerId: offer._id,
        offerName: offer.name,
        userId,
        orderId,
        orderNumber: params.order.orderNumber,
        freeUnits: params.freeUnits,
        discountAmount: params.discountAmount,
        perUserSeq: seq,
        usedAt: new Date(),
      });
      created = true;
    } catch (err) {
      if (isDuplicateKeyError(err, "orderId")) return; // already consumed for this order
      if (isDuplicateKeyError(err, "perUserSeq")) continue; // lost the race, take the next slot
      throw err;
    }
  }
  if (!created) throw new AppError("This offer is no longer available.", 409);

  const incremented = await Offer.findOneAndUpdate(
    {
      _id: offer._id,
      status: "ACTIVE",
      $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
    },
    { $inc: { usedCount: 1 } }
  ).exec();

  if (!incremented) {
    await OfferUsage.deleteOne({ offerId: offer._id, orderId }).catch(() => undefined);
    throw new AppError("This offer is no longer available.", 409);
  }
}

/**
 * Full reversal when an order is cancelled/abandoned. Idempotent: the usage
 * row delete is the claim, so a second cancel path finds nothing to undo.
 * Never throws (a cancellation must not be blocked by a counter). NOT called
 * on refund — a refunded order was fulfilled, so the redemption stands.
 */
export async function releaseOfferForOrder(order: {
  _id: mongoose.Types.ObjectId | string;
  orderNumber?: string;
  offer?: { offerId: mongoose.Types.ObjectId | string } | null;
}): Promise<void> {
  if (!order.offer?.offerId) return;
  const orderId = typeof order._id === "string" ? new mongoose.Types.ObjectId(order._id) : order._id;
  try {
    const removed = await OfferUsage.findOneAndDelete({ orderId }).exec();
    if (removed) {
      await Offer.updateOne({ _id: removed.offerId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }).exec();
      await Order.updateOne({ _id: orderId }, { $set: { "offer.released": true } }).exec();
    }
  } catch (err) {
    console.error("Offer release failed", {
      orderNumber: order.orderNumber,
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

// ---- Public (storefront) ----

/**
 * Active offers for the storefront. Category lists are expanded to include
 * descendants so the client can badge a product with a plain set lookup. This
 * is DISPLAY data — cart/checkout re-evaluate everything server-side.
 */
export async function listPublicActiveOffers(now: Date = new Date()) {
  const offers = await loadLiveOffers(now);
  const exhausted = offers.filter((o) => o.usageLimit != null && o.usedCount >= o.usageLimit);
  const live = offers.filter((o) => !exhausted.includes(o));
  const descendants = await loadDescendantsMap([
    ...new Set(live.flatMap((o) => [...o.eligibleCategoryIds, ...o.excludedCategoryIds].map(String))),
  ]);
  const expand = (ids: unknown[]) => {
    const out = new Set<string>();
    for (const id of ids) for (const d of descendants.get(String(id)) ?? [String(id)]) out.add(d);
    return [...out];
  };
  const images = await loadOfferImageMap(live.map((o) => o.imageMediaId));
  // Names for the products an offer talks about ("buy X, get Y free"), in one query.
  const referencedIds = [...new Set(live.flatMap((o) => [...o.eligibleProductIds, ...(o.freeProductIds ?? [])].map(String)))];
  const referenced = referencedIds.length
    ? await Product.find({ _id: { $in: referencedIds } }).select("name slug").lean()
    : [];
  const productNames: Record<string, { name: string; slug: string }> = {};
  for (const p of referenced) productNames[p._id.toString()] = { name: p.name, slug: p.slug };
  return live.map((o) => ({
    id: o._id.toString(),
    name: o.name,
    mode: getOfferMode(o),
    discountPercent: o.type === "PERCENTAGE" ? o.discountPercent ?? null : null,
    discountAmount: o.type === "FIXED" ? o.discountAmount ?? null : null,
    freeProductIds: (o.freeProductIds ?? []).map(String),
    productNames: Object.fromEntries(
      [...o.eligibleProductIds, ...(o.freeProductIds ?? [])]
        .map(String)
        .filter((id) => productNames[id])
        .map((id) => [id, productNames[id]])
    ),
    description: o.description ?? null,
    image: o.imageMediaId ? images.get(o.imageMediaId.toString()) ?? null : null,
    type: o.type,
    buyQuantity: o.buyQuantity,
    maxFreeUnitsPerOrder: o.maxFreeUnitsPerOrder,
    minPaidUnitPrice: o.minPaidUnitPrice ?? 0,
    allowCouponStacking: o.allowCouponStacking ?? false,
    startsAt: o.startsAt ? o.startsAt.toISOString() : null,
    endsAt: o.endsAt ? o.endsAt.toISOString() : null,
    applyToAll: false,
    eligibleProductIds: o.eligibleProductIds.map(String),
    eligibleCategoryIds: [],
    excludedProductIds: o.excludedProductIds.map(String),
    excludedCategoryIds: expand(o.excludedCategoryIds),
  }));
}
