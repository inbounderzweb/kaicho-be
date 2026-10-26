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
  /** Role mode only: no unit of any configured free product is in the cart, so nothing can be free yet. */
  needsFreeProduct: boolean;
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
    needsFreeProduct: false,
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
 * AUTO mode — no customer preference. Every (buyQuantity + 1) eligible units
 * earn ONE free unit, so the free count grows with the cart: 2 units → 1 free,
 * 4 → 2, 6 → 3 (buy 1 get 1), up to the per-order cap. The FREE units are the
 * cheapest ones and the customer pays for the highest-priced: with ₹190, ₹180,
 * ₹140, ₹140 and room for two free units, the two ₹140 items are free and the
 * ₹190 and ₹180 ones are charged. Every paid unit therefore costs at least as
 * much as every free unit, so the price rule always holds. If the units that
 * would have to be paid for fall below the minimum purchased price, fewer free
 * units are given.
 */
export function computeAutoAllocation(lines: EngineLine[], rule: OfferEngineRule): EngineResult {
  const result = emptyResult();
  const units = expand(lines).sort(byPriceDesc); // dearest first
  const groupSize = rule.buyQuantity + 1;

  const possible = Math.floor(units.length / groupSize);
  let freeCount = Math.min(possible, rule.maxFreeUnitsPerOrder);
  const capBinding = possible > rule.maxFreeUnitsPerOrder;

  // The paid partners are the dearest freeCount*buyQuantity units; the cheapest
  // of them must still meet the minimum purchased price.
  while (freeCount > 0 && units[freeCount * rule.buyQuantity - 1].priceMinor < rule.minPaidUnitPriceMinor) {
    freeCount--;
  }

  const freeUnits = freeCount > 0 ? units.slice(units.length - freeCount) : [];
  const groups: { free: Unit; paid: Unit[] }[] = freeUnits.map((free, i) => ({
    free,
    paid: units.slice(i * rule.buyQuantity, (i + 1) * rule.buyQuantity),
  }));

  result.limitReached = capBinding && freeCount === rule.maxFreeUnitsPerOrder;
  if (!result.limitReached && freeCount < rule.maxFreeUnitsPerOrder) {
    result.unitsToNextFree = Math.max(0, (freeCount + 1) * groupSize - units.length);
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


// ---------------------------------------------------------------------------
// ROLE mode — the offer names the products the customer must BUY and,
// separately, the products they receive FREE. A product may sit in both lists
// (it can then play either role, but one unit never plays both). Unlike the
// pooled engine above there is no "free costs no more than paid" rule: the
// admin chose the free product on purpose (buy Navadhanya, get Chicken Oats).
// ---------------------------------------------------------------------------

/** A cart line already known to be active and in stock, tagged with the roles its product may play. */
export interface RoleLine extends EngineLine {
  /** Product is on the offer's "must buy" list. */
  canPay: boolean;
  /** Product is on the offer's "free product" list. */
  canFree: boolean;
}

interface RoleUnit extends Unit {
  canPay: boolean;
  canFree: boolean;
}

function expandRoles(lines: RoleLine[]): RoleUnit[] {
  const units: RoleUnit[] = [];
  for (const l of lines) {
    for (let i = 0; i < l.quantity; i++) {
      units.push({ productId: l.productId, priceMinor: l.unitPriceMinor, canPay: l.canPay, canFree: l.canFree });
    }
  }
  return units;
}

// Dearest first; on a tie prefer units that can ONLY be free, so a shared
// unit stays available as a paid partner.
const freeOrder = (a: RoleUnit, b: RoleUnit) =>
  b.priceMinor - a.priceMinor ||
  Number(a.canPay) - Number(b.canPay) ||
  (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);

// Free-only units first (they never consume a paid partner), then dearest.
const freeOnlyFirst = (a: RoleUnit, b: RoleUnit) =>
  Number(a.canPay) - Number(b.canPay) ||
  b.priceMinor - a.priceMinor ||
  (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);

// Cheapest qualifying partners first — they only have to meet the minimum.
const payerOrder = (a: Unit, b: Unit) =>
  a.priceMinor - b.priceMinor || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);

function payersAfter(units: RoleUnit[], free: Set<RoleUnit>, rule: OfferEngineRule): RoleUnit[] {
  return units
    .filter((u) => u.canPay && !free.has(u) && u.priceMinor >= rule.minPaidUnitPriceMinor)
    .sort(payerOrder);
}

/**
 * AUTO mode for role offers: gives as many free units as the cart and the
 * per-order cap allow. Every free unit needs `buyQuantity` distinct qualifying
 * units that are not themselves free.
 */
export function computeRoleAutoAllocation(lines: RoleLine[], rule: OfferEngineRule): EngineResult {
  const result = emptyResult();
  const units = expandRoles(lines);
  const freeCandidates = units.filter((u) => u.canFree);
  if (freeCandidates.length === 0) {
    result.needsFreeProduct = units.some((u) => u.canPay);
    return result;
  }

  const byValue = [...freeCandidates].sort(freeOrder);
  const byFeasibility = [...freeCandidates].sort(freeOnlyFirst);
  const maxK = Math.min(rule.maxFreeUnitsPerOrder, freeCandidates.length);

  let chosenFree: RoleUnit[] = [];
  let chosenPayers: RoleUnit[] = [];
  for (let k = maxK; k >= 1; k--) {
    let best: { free: RoleUnit[]; payers: RoleUnit[]; value: number } | null = null;
    for (const order of [byValue, byFeasibility]) {
      const free = order.slice(0, k);
      const payers = payersAfter(units, new Set(free), rule);
      if (payers.length < k * rule.buyQuantity) continue;
      const value = free.reduce((sum, u) => sum + u.priceMinor, 0);
      if (!best || value > best.value) best = { free, payers, value };
    }
    if (best) {
      chosenFree = best.free;
      chosenPayers = best.payers;
      break;
    }
  }

  const k = chosenFree.length;
  const possibleFree = freeCandidates.length;
  result.limitReached = k === rule.maxFreeUnitsPerOrder && possibleFree > k;

  // How far from the next free unit? Assume one more free unit is claimed.
  if (!result.limitReached && possibleFree > k) {
    const nextFree = new Set(byFeasibility.slice(0, k + 1));
    const available = payersAfter(units, nextFree, rule).length;
    result.unitsToNextFree = Math.max(0, (k + 1) * rule.buyQuantity - available);
  }

  const free = [...chosenFree].sort(freeOrder);
  const groups = free.map((f, i) => ({
    free: f,
    paid: chosenPayers.slice(i * rule.buyQuantity, (i + 1) * rule.buyQuantity),
  }));
  return finalize(result, groups);
}

/**
 * SELECTION mode for role offers: the customer says which free-product units
 * they want free. Picks outside the free list, beyond the cart, beyond the
 * per-order cap, or without enough qualifying partners are reported in
 * `rejected` and stay paid.
 */
export function computeRoleSelectionAllocation(
  lines: RoleLine[],
  selection: { productId: string; quantity: number }[],
  rule: OfferEngineRule
): EngineResult {
  const result = emptyResult();
  const byProduct = new Map(lines.map((l) => [l.productId, l]));

  const wanted = new Map<string, number>();
  for (const s of selection) {
    if (s.quantity > 0) wanted.set(s.productId, (wanted.get(s.productId) ?? 0) + s.quantity);
  }

  const units = expandRoles(lines);
  const picked: RoleUnit[] = [];
  for (const [productId, qty] of wanted) {
    const line = byProduct.get(productId);
    if (!line || !line.canFree) {
      result.rejected.push({
        productId,
        quantity: qty,
        reason: "NOT_ELIGIBLE",
        message: "This item isn't one of the free items for this offer.",
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
    const pool = units.filter((u) => u.productId === productId);
    picked.push(...pool.slice(0, usable));
  }
  picked.sort(freeOrder);

  const used = new Set<RoleUnit>();
  const groups: { free: RoleUnit; paid: RoleUnit[] }[] = [];
  const rejectedAgg = new Map<string, RejectedSelection>();
  const addRejected = (u: Unit, reason: RejectionReason, message: string) => {
    const key = `${u.productId}|${reason}`;
    const cur = rejectedAgg.get(key);
    if (cur) cur.quantity += 1;
    else rejectedAgg.set(key, { productId: u.productId, quantity: 1, reason, message });
  };

  // Every picked unit is held back from the paid pool up front; a rejected
  // one is returned to it (it stays a paid unit and may partner a later pick).
  const held = new Set(picked);
  for (const free of picked) {
    if (groups.length >= rule.maxFreeUnitsPerOrder) {
      result.limitReached = true;
      addRejected(free, "LIMIT_REACHED", `The offer allows at most ${rule.maxFreeUnitsPerOrder} free item(s) per order.`);
      held.delete(free);
      continue;
    }
    const partners = units
      .filter((u) => u.canPay && !held.has(u) && !used.has(u) && u.priceMinor >= rule.minPaidUnitPriceMinor)
      .sort(payerOrder)
      .slice(0, rule.buyQuantity);
    if (partners.length < rule.buyQuantity) {
      const anyPrice = units.filter((u) => u.canPay && !held.has(u) && !used.has(u)).length;
      addRejected(
        free,
        anyPrice < rule.buyQuantity ? "NOT_ENOUGH_PAID_ITEMS" : "PRICE_TOO_HIGH",
        anyPrice < rule.buyQuantity
          ? `Add ${rule.buyQuantity - anyPrice} more qualifying item(s) to get this one free.`
          : "None of the items you are buying meet this offer's minimum price."
      );
      held.delete(free);
      continue;
    }
    partners.forEach((u) => used.add(u));
    groups.push({ free, paid: partners });
  }

  result.rejected.push(...rejectedAgg.values());
  return finalize(result, groups);
}

// ---------------------------------------------------------------------------
// PERCENTAGE / FIXED — a discount on every unit of the eligible products.
// Per-UNIT paise are computed first and multiplied by quantity, so the amount
// a product card shows for one unit is exactly what the cart takes off per unit.
// ---------------------------------------------------------------------------

export type DiscountRule =
  | { kind: "PERCENTAGE"; percent: number }
  | { kind: "FIXED"; amountMinor: number };

export interface DiscountResult {
  discountMinor: number;
  /** productId -> paise taken off that product's whole line. */
  discountMinorByProduct: Map<string, number>;
}

/** Paise off ONE unit priced `unitPriceMinor`. Never more than the unit costs. */
export function unitDiscountMinor(unitPriceMinor: number, rule: DiscountRule): number {
  const raw =
    rule.kind === "PERCENTAGE" ? Math.round((unitPriceMinor * rule.percent) / 100) : rule.amountMinor;
  return Math.max(0, Math.min(unitPriceMinor, raw));
}

export function computeDiscountAllocation(lines: EngineLine[], rule: DiscountRule): DiscountResult {
  const byProduct = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    const off = unitDiscountMinor(l.unitPriceMinor, rule) * l.quantity;
    if (off <= 0) continue;
    byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + off);
    total += off;
  }
  return { discountMinor: total, discountMinorByProduct: byProduct };
}
