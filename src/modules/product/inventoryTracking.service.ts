import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { InventoryComponent, InventoryTracking, Pack, Product } from "../../database/models";

// ---- Inventory Tracking resolution ----
// Pure, DB-free functions — mirrors packCombination.service.ts's style
// deliberately: same "isolated from controllers, fully unit-testable"
// principle (spec §14/§18/§25). Every dependency (which components exist,
// live stock) is passed in as plain data.

export interface ResolvedComponent {
  productId: string;
  /** Units of this component consumed per ONE unit of whatever it's attached to (one pack, or one plain product unit) — never multiplied by pack.quantity again. */
  quantity: number;
}

// Merges duplicate productIds by summing their quantities (spec §13, Option
// B — consolidate rather than reject). Used both when an admin saves a
// components list and defensively wherever one is read, so a duplicate
// slipping in through any path never double-counts or silently picks one.
export function consolidateComponents(components: InventoryComponent[]): ResolvedComponent[] {
  const byProductId = new Map<string, number>();
  for (const c of components) {
    const id = c.productId.toString();
    byProductId.set(id, (byProductId.get(id) ?? 0) + c.quantity);
  }
  return [...byProductId.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

// The fallback chain that makes "never configured" behave exactly as this
// codebase did before this feature existed (spec §9/§10):
//  - A pack with its own `useComponentInventory` + non-empty
//    `inventoryComponents` uses exactly that (a genuine multi-product combo
//    pack, or an explicit self-reference).
//  - Otherwise, if a `pack` was given at all, it implicitly resolves to
//    "`pack.quantity` units of its own parent product" — the literal
//    pre-existing pack behaviour, expressed in the same shape so callers
//    never need to special-case it.
//  - With no pack (a plain/base product purchase): the product's own
//    `inventoryTracking` if enabled, else "1 unit of itself" — the literal
//    pre-existing direct-inventory behaviour.
export function resolveEffectiveComponents(
  product: { _id: { toString(): string }; inventoryTracking?: InventoryTracking },
  pack?: Pick<Pack, "quantity" | "useComponentInventory" | "inventoryComponents">
): ResolvedComponent[] {
  if (pack) {
    if (pack.useComponentInventory && pack.inventoryComponents.length > 0) {
      return consolidateComponents(pack.inventoryComponents);
    }
    return [{ productId: product._id.toString(), quantity: pack.quantity }];
  }

  if (product.inventoryTracking?.enabled && product.inventoryTracking.components.length > 0) {
    return consolidateComponents(product.inventoryTracking.components);
  }
  return [{ productId: product._id.toString(), quantity: 1 }];
}

// Sums quantities for the same productId across several already-resolved
// component lists — e.g. combining every pack selection's own requirement
// within one cart line, or combining every line's requirement across a
// whole order, so a component shared by two different lines/packs is
// checked/deducted once for its true total rather than twice independently
// (which could let two lines each individually "pass" a stock check that
// their combined demand actually fails).
export function mergeResolvedComponents(...lists: ResolvedComponent[][]): ResolvedComponent[] {
  const byProductId = new Map<string, number>();
  for (const list of lists) {
    for (const c of list) {
      byProductId.set(c.productId, (byProductId.get(c.productId) ?? 0) + c.quantity);
    }
  }
  return [...byProductId.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

// The one DB-touching function in this otherwise-pure module — shared by
// every admin save path that accepts a components list (product-level
// inventoryTracking, and a pack's own inventoryComponents override, on both
// the product- and category-scoped routers). Enforces spec §11/§12/§13:
//  - every referenced id must be a real, existing product (never a
//    duplicate/virtual inventory record);
//  - it must not itself be a combo (inventoryTracking.enabled) — components
//    reference base products only, so inventory calculation stays
//    deterministic and circular references are impossible by construction;
//  - duplicate productIds are consolidated (summed), never left ambiguous.
export async function assertAndConsolidateComponents(
  components: { productId: string; quantity: number }[] | undefined
): Promise<{ productId: mongoose.Types.ObjectId; quantity: number }[]> {
  if (!components || components.length === 0) return [];

  const consolidated = consolidateComponents(
    components.map((c) => ({ productId: new mongoose.Types.ObjectId(c.productId), quantity: c.quantity }))
  );

  const referenced = await Product.find({ _id: { $in: consolidated.map((c) => c.productId) } })
    .select("name inventoryTracking")
    .lean();
  const byId = new Map(referenced.map((p) => [p._id.toString(), p]));

  for (const c of consolidated) {
    const product = byId.get(c.productId);
    if (!product) {
      throw new AppError("One or more selected component products don't exist", 400);
    }
    if (product.inventoryTracking?.enabled) {
      throw new AppError(
        `"${product.name}" is itself a tracked combo and can't be used as a component — components must reference base products (spec §12)`,
        400
      );
    }
  }

  return consolidated.map((c) => ({ productId: new mongoose.Types.ObjectId(c.productId), quantity: c.quantity }));
}

// spec §14's calculateInventoryRequirement — pure multiply, no hard-coded
// quantities (spec §7/§10 non-negotiable rule).
export function calculateInventoryRequirement(
  components: ResolvedComponent[],
  purchaseQuantity: number
): ResolvedComponent[] {
  return components.map((c) => ({ productId: c.productId, quantity: c.quantity * purchaseQuantity }));
}

export interface AvailabilityResult {
  available: boolean;
  /** Component productIds that don't have enough stock, when unavailable. */
  shortfalls: string[];
}

// spec §8: a combo is available only when EVERY component has enough stock
// — all-or-nothing by default, no partial fulfillment. A component genuinely
// missing from `stockByProductId` (the referenced product doesn't exist any
// more) is a shortfall, same as zero stock — never silently ignored. A
// component that's *present but untracked* (trackInventory: false,
// deliberately unlimited) is always available, same as any other untracked
// product in this codebase.
export function validateInventoryAvailability(
  components: ResolvedComponent[],
  purchaseQuantity: number,
  stockByProductId: Map<string, { stockQuantity: number; trackInventory: boolean }>
): AvailabilityResult {
  const required = calculateInventoryRequirement(components, purchaseQuantity);
  const shortfalls = required
    .filter((r) => {
      const stock = stockByProductId.get(r.productId);
      if (!stock) return true;
      if (!stock.trackInventory) return false;
      return stock.stockQuantity < r.quantity;
    })
    .map((r) => r.productId);
  return { available: shortfalls.length === 0, shortfalls };
}

// spec §9: the limiting component determines how many complete combos can
// be fulfilled right now — `min(floor(stock / quantity-per-unit))` across
// every component. A component with quantity <= 0 can't happen (schema
// enforces min 1) but is guarded defensively. A missing component caps
// availability at 0 (mirrors validateInventoryAvailability); an untracked
// one doesn't constrain at all.
export function calculateMaximumAvailableQuantity(
  components: ResolvedComponent[],
  stockByProductId: Map<string, { stockQuantity: number; trackInventory: boolean }>
): number {
  if (components.length === 0) return 0;
  let max = Infinity;
  for (const c of components) {
    if (c.quantity <= 0) continue;
    const stock = stockByProductId.get(c.productId);
    if (!stock) return 0;
    if (!stock.trackInventory) continue; // untracked — doesn't constrain
    max = Math.min(max, Math.floor(stock.stockQuantity / c.quantity));
  }
  return max === Infinity ? Infinity : Math.max(0, max);
}
