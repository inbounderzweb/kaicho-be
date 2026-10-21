// Pure BOGO pairing engine — no DB, no clock, no I/O. Everything money-related
// is integer paise so a 3-unit cart can't drift a paisa. offer.service.ts
// feeds it trusted, DB-sourced prices; nothing here ever sees a client price.
//
// THE RULE (spec §2): a free unit's price must be <= the price of every paid
// unit it is paired with. A more expensive item can never be free against a
// cheaper purchase.

export interface OfferEngineRule {
  buyQuantity: number;
  maxFreeUnitsPerOrder: number;
  /** Paise. Paid units priced below this can't unlock a free unit. */
  minPaidUnitPriceMinor: number;
}

/** One cart line that is ALREADY known to be eligible, in stock and active. */
export interface EngineLine {
  productId: string;
  /** Applicable selling price in paise (after product-level discount). */
  unitPriceMinor: number;
  quantity: number;
}

export type RejectionReason =
  | "PRICE_TOO_HIGH"
  | "NOT_ENOUGH_PAID_ITEMS"
  | "LIMIT_REACHED"
  | "NOT_ELIGIBLE"
  | "NOT_IN_CART";

export interface RejectedSelection {
  productId: string;
  quantity: number;
  reason: RejectionReason;
  message: string;
}

export interface EnginePair {
  freeProductId: string;
  freeUnitPriceMinor: number;
  paid: { productId: string; unitPriceMinor: number; quantity: number }[];
  count: number;
}

export interface EngineResult {
  /** productId -> number of FREE units among that line's quantity. */
  freeByProduct: Map<string, number>;
  freeUnits: number;
  discountMinor: number;
  pairs: EnginePair[];
  rejected: RejectedSelection[];
  /** True when the free-unit cap, not the cart, was what stopped more pairs. */
  limitReached: boolean;
  /** Additional eligible paid units needed before the next free unit unlocks (0 if cap hit). */
  unitsToNextFree: number;
}

interface Unit {
  productId: string;
  priceMinor: number;
}

// Deterministic order: price desc, then productId asc.
function byPriceDesc(a: Unit, b: Unit): number {
  return b.priceMinor - a.priceMinor || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
}

function expand(lines: EngineLine[]): Unit[] {
  const units: Unit[] = [];
  for (const l of lines) {
    for (let i = 0; i < l.quantity; i++) units.push({ productId: l.productId, priceMinor: l.unitPriceMinor });
  }
  return units;
}

function emptyResult(): EngineResult {
  return {
    freeByProduct: new Map(),
    freeUnits: 0,
    discountMinor: 0,
    pairs: [],
    rejected: [],
    limitReached: false,
    unitsToNextFree: 0,
  };
}

function finalize(
  result: EngineResult,
  groups: { free: Unit; paid: Unit[] }[]
): EngineResult {
  const pairMap = new Map<string, EnginePair>();
  for (const { free, paid } of groups) {
    result.freeUnits += 1;
    result.discountMinor += free.priceMinor; // 100% off a unit never exceeds that unit's price
    result.freeByProduct.set(free.productId, (result.freeByProduct.get(free.productId) ?? 0) + 1);

    const paidAgg = new Map<string, { productId: string; unitPriceMinor: number; quantity: number }>();
    for (const p of paid) {
      const k = `${p.productId}@${p.priceMinor}`;
      const cur = paidAgg.get(k);
      if (cur) cur.quantity += 1;
      else paidAgg.set(k, { productId: p.productId, unitPriceMinor: p.priceMinor, quantity: 1 });
    }
    const paidList = [...paidAgg.values()].sort(
      (a, b) => b.unitPriceMinor - a.unitPriceMinor || a.productId.localeCompare(b.productId)
    );
    const key = `${free.productId}@${free.priceMinor}|${paidList.map((p) => `${p.productId}@${p.unitPriceMinor}x${p.quantity}`).join(",")}`;
    const existing = pairMap.get(key);
    if (existing) existing.count += 1;
    else
      pairMap.set(key, {
        freeProductId: free.productId,
        freeUnitPriceMinor: free.priceMinor,
        paid: paidList,
        count: 1,
      });
  }
  result.pairs = [...pairMap.values()];
  return result;
}

/**
 * AUTO mode — no customer preference. Sort eligible units by price desc and
 * cut them into consecutive groups of (buyQuantity + 1): the first
 * `buyQuantity` are paid, the last (the group's CHEAPEST) is free. Pairing
 * neighbours maximises savings while guaranteeing free <= every paid unit in
 * its group. Stops at the cap, at the first group that can't be completed,
 * and at the first group whose cheapest paid unit is below the minimum.
 */
export function computeAutoAllocation(lines: EngineLine[], rule: OfferEngineRule): EngineResult {
  const result = emptyResult();
  const units = expand(lines).sort(byPriceDesc);
  const groupSize = rule.buyQuantity + 1;

  const groups: { free: Unit; paid: Unit[] }[] = [];
  let cursor = 0;
  while (cursor + groupSize <= units.length) {
    if (groups.length >= rule.maxFreeUnitsPerOrder) {
      result.limitReached = true;
      break;
    }
    const paid = units.slice(cursor, cursor + rule.buyQuantity);
    // Sorted desc, so paid[last] is the group's cheapest paid unit — and every
    // later group is cheaper still, so the first failure ends the search.
    if (paid[paid.length - 1].priceMinor < rule.minPaidUnitPriceMinor) break;
    groups.push({ free: units[cursor + rule.buyQuantity], paid });
    cursor += groupSize;
  }

  const remaining = units.length - cursor;
  if (!result.limitReached && groups.length < rule.maxFreeUnitsPerOrder) {
    result.unitsToNextFree = remaining === 0 ? groupSize : Math.max(0, groupSize - remaining);
  }
  return finalize(result, groups);
}

/**
 * SELECTION mode — the customer named which units they want free. Each is
 * validated against the rule; the ones that fail are NOT silently made free:
 * they stay paid and come back in `rejected` with a reason (spec §2.3-2.4).
 *
 * Free picks are processed most-expensive-first. Each takes the CHEAPEST
 * still-unused paid units that are >= its price (exchange argument: that
 * leaves the pricier paid units for the picks that need them). A unit picked
 * as free is removed from the paid pool, so the same unit is never both.
 */
export function computeSelectionAllocation(
  lines: EngineLine[],
  selection: { productId: string; quantity: number }[],
  rule: OfferEngineRule
): EngineResult {
  const result = emptyResult();
  const byProduct = new Map(lines.map((l) => [l.productId, l]));

  // Collapse duplicate selection rows and clamp to what's actually in the cart.
  const wanted = new Map<string, number>();
  for (const s of selection) {
    if (s.quantity <= 0) continue;
    wanted.set(s.productId, (wanted.get(s.productId) ?? 0) + s.quantity);
  }

  const freeCandidates: Unit[] = [];
  for (const [productId, qty] of wanted) {
    const line = byProduct.get(productId);
    if (!line) {
      result.rejected.push({
        productId,
        quantity: qty,
        reason: "NOT_ELIGIBLE",
        message: "This item doesn't qualify for the offer.",
      });
      continue;
    }
    const usable = Math.min(qty, line.quantity);
    if (qty > usable) {
      result.rejected.push({
        productId,
        quantity: qty - usable,
        reason: "NOT_IN_CART",
        message: "You selected more free units than you have in your cart.",
      });
    }
    for (let i = 0; i < usable; i++) freeCandidates.push({ productId, priceMinor: line.unitPriceMinor });
  }
  freeCandidates.sort(byPriceDesc);

  // Paid pool = every eligible unit that is not a free candidate. Ascending so
  // we can pick "cheapest that is still >= the free price".
  const freeCount = new Map<string, number>();
  for (const f of freeCandidates) freeCount.set(f.productId, (freeCount.get(f.productId) ?? 0) + 1);
  const pool: Unit[] = [];
  for (const l of lines) {
    const paidQty = l.quantity - (freeCount.get(l.productId) ?? 0);
    for (let i = 0; i < paidQty; i++) pool.push({ productId: l.productId, priceMinor: l.unitPriceMinor });
  }
  pool.sort((a, b) => a.priceMinor - b.priceMinor || (a.productId < b.productId ? -1 : 1));

  const rejectedAgg = new Map<string, RejectedSelection>();
  const addRejected = (u: Unit, reason: RejectionReason, message: string) => {
    const k = `${u.productId}|${reason}`;
    const cur = rejectedAgg.get(k);
    if (cur) cur.quantity += 1;
    else rejectedAgg.set(k, { productId: u.productId, quantity: 1, reason, message });
  };

  const groups: { free: Unit; paid: Unit[] }[] = [];
  const taken = new Set<Unit>();
  // A rejected pick stays a PAID unit, so it goes back into the pool and may
  // legitimately serve as the paid partner of a later (cheaper) pick.
  const returnToPool = (u: Unit) => {
    pool.push(u);
    pool.sort((a, b) => a.priceMinor - b.priceMinor || (a.productId < b.productId ? -1 : 1));
  };
  for (const free of freeCandidates) {
    if (groups.length >= rule.maxFreeUnitsPerOrder) {
      result.limitReached = true;
      addRejected(free, "LIMIT_REACHED", `The offer allows at most ${rule.maxFreeUnitsPerOrder} free item(s) per order.`);
      returnToPool(free);
      continue;
    }
    const chosen: Unit[] = [];
    const minNeeded = Math.max(free.priceMinor, rule.minPaidUnitPriceMinor);
    for (const candidate of pool) {
      if (chosen.length >= rule.buyQuantity) break;
      if (!taken.has(candidate) && candidate.priceMinor >= minNeeded) chosen.push(candidate);
    }
    if (chosen.length < rule.buyQuantity) {
      // Distinguish "not enough items at all" from "nothing costs enough".
      const availableAtAnyPrice = pool.filter((u) => !taken.has(u)).length;
      if (availableAtAnyPrice < rule.buyQuantity) {
        addRejected(free, "NOT_ENOUGH_PAID_ITEMS", `Add ${rule.buyQuantity - availableAtAnyPrice} more eligible item(s) to get this one free.`);
      } else {
        addRejected(
          free,
          "PRICE_TOO_HIGH",
          "A free item can't cost more than the item you buy. Pick a cheaper free item or add a higher-priced eligible item."
        );
      }
      returnToPool(free);
      continue;
    }
    for (const u of chosen) taken.add(u);
    groups.push({ free, paid: chosen });
  }

  result.rejected.push(...rejectedAgg.values());
  return finalize(result, groups);
}

/** Sum of paid-line minor amounts helper used by callers for sanity checks. */
export function toMinor(rupees: number): number {
  return Math.round(rupees * 100);
}
