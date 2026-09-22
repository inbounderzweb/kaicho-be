import { describe, it, expect } from "vitest";
import {
  resolveEffectiveComponents,
  calculateInventoryRequirement,
  validateInventoryAvailability,
  calculateMaximumAvailableQuantity,
  consolidateComponents,
  mergeResolvedComponents,
  type ResolvedComponent,
} from "../inventoryTracking.service";
import type { Pack, InventoryComponent } from "../../../database/models";

function component(productId: string, quantity: number): InventoryComponent {
  return { productId: productId as never, quantity };
}

const NAVADHANYA = "navadhanya-id";
const MILLET = "millet-id";
const RAGI = "ragi-id";
const OATS = "oats-id";

describe("resolveEffectiveComponents — fallback chain (spec §9/§10)", () => {
  it("a plain product with no inventoryTracking resolves to itself × 1 unit", () => {
    const product = { _id: { toString: () => "prod-1" }, inventoryTracking: undefined };
    expect(resolveEffectiveComponents(product)).toEqual([{ productId: "prod-1", quantity: 1 }]);
  });

  it("a plain product with inventoryTracking enabled resolves to its own components", () => {
    const product = {
      _id: { toString: () => "combo-1" },
      inventoryTracking: { enabled: true, components: [component(NAVADHANYA, 2), component(MILLET, 1)] },
    };
    const resolved = resolveEffectiveComponents(product);
    expect(resolved).toContainEqual({ productId: NAVADHANYA, quantity: 2 });
    expect(resolved).toContainEqual({ productId: MILLET, quantity: 1 });
  });

  it("a pack with no override resolves to pack.quantity units of its own parent product — today's exact behaviour", () => {
    const product = { _id: { toString: () => "parent-1" }, inventoryTracking: undefined };
    const pack = { quantity: 5, useComponentInventory: false, inventoryComponents: [] } as Pick<
      Pack,
      "quantity" | "useComponentInventory" | "inventoryComponents"
    >;
    expect(resolveEffectiveComponents(product, pack)).toEqual([{ productId: "parent-1", quantity: 5 }]);
  });

  it("a pack with useComponentInventory but an empty list still falls back to the parent", () => {
    const product = { _id: { toString: () => "parent-1" }, inventoryTracking: undefined };
    const pack = { quantity: 5, useComponentInventory: true, inventoryComponents: [] } as Pick<
      Pack,
      "quantity" | "useComponentInventory" | "inventoryComponents"
    >;
    expect(resolveEffectiveComponents(product, pack)).toEqual([{ productId: "parent-1", quantity: 5 }]);
  });

  it("a pack with an explicit component override uses exactly that, ignoring pack.quantity", () => {
    const product = { _id: { toString: () => "parent-1" }, inventoryTracking: undefined };
    const pack = {
      quantity: 999, // deliberately different — must be ignored once components are configured
      useComponentInventory: true,
      inventoryComponents: [component(NAVADHANYA, 1), component(MILLET, 1), component(RAGI, 1)],
    } as Pick<Pack, "quantity" | "useComponentInventory" | "inventoryComponents">;
    const resolved = resolveEffectiveComponents(product, pack);
    expect(resolved).toHaveLength(3);
    expect(resolved).toContainEqual({ productId: NAVADHANYA, quantity: 1 });
  });
});

describe("calculateInventoryRequirement — spec §14's own worked examples", () => {
  it("§6: a 4-product combo × 5", () => {
    const components: ResolvedComponent[] = [
      { productId: NAVADHANYA, quantity: 1 },
      { productId: MILLET, quantity: 1 },
      { productId: RAGI, quantity: 1 },
      { productId: OATS, quantity: 1 },
    ];
    const required = calculateInventoryRequirement(components, 5);
    for (const r of required) expect(r.quantity).toBe(5);
  });

  it("§7: uneven per-component quantities × 2 (Family Combo)", () => {
    const components: ResolvedComponent[] = [
      { productId: NAVADHANYA, quantity: 2 },
      { productId: MILLET, quantity: 1 },
      { productId: RAGI, quantity: 3 },
      { productId: OATS, quantity: 1 },
    ];
    const required = calculateInventoryRequirement(components, 2);
    const byId = Object.fromEntries(required.map((r) => [r.productId, r.quantity]));
    expect(byId[NAVADHANYA]).toBe(4);
    expect(byId[MILLET]).toBe(2);
    expect(byId[RAGI]).toBe(6);
    expect(byId[OATS]).toBe(2);
  });
});

describe("validateInventoryAvailability (spec §8 — all-or-nothing)", () => {
  it("unavailable when even one component is short", () => {
    const components: ResolvedComponent[] = [
      { productId: NAVADHANYA, quantity: 2 },
      { productId: MILLET, quantity: 1 },
      { productId: RAGI, quantity: 3 },
    ];
    const stock = new Map([
      [NAVADHANYA, { stockQuantity: 20, trackInventory: true }],
      [MILLET, { stockQuantity: 10, trackInventory: true }],
      [RAGI, { stockQuantity: 2, trackInventory: true }], // needs 3, has 2
    ]);
    const result = validateInventoryAvailability(components, 1, stock);
    expect(result.available).toBe(false);
    expect(result.shortfalls).toEqual([RAGI]);
  });

  it("available when every component has enough", () => {
    const components: ResolvedComponent[] = [
      { productId: NAVADHANYA, quantity: 2 },
      { productId: RAGI, quantity: 3 },
    ];
    const stock = new Map([
      [NAVADHANYA, { stockQuantity: 20, trackInventory: true }],
      [RAGI, { stockQuantity: 8, trackInventory: true }],
    ]);
    expect(validateInventoryAvailability(components, 1, stock).available).toBe(true);
  });

  it("a missing (deleted) component product is always a shortfall, never silently ignored", () => {
    const components: ResolvedComponent[] = [{ productId: "gone", quantity: 1 }];
    expect(validateInventoryAvailability(components, 1, new Map()).available).toBe(false);
  });

  it("an untracked component never blocks availability", () => {
    const components: ResolvedComponent[] = [{ productId: NAVADHANYA, quantity: 1000 }];
    const stock = new Map([[NAVADHANYA, { stockQuantity: 0, trackInventory: false }]]);
    expect(validateInventoryAvailability(components, 1, stock).available).toBe(true);
  });
});

describe("calculateMaximumAvailableQuantity (spec §9 — exact worked example)", () => {
  it("the limiting component determines the max: Ragi caps it at 2", () => {
    const components: ResolvedComponent[] = [
      { productId: NAVADHANYA, quantity: 2 },
      { productId: MILLET, quantity: 1 },
      { productId: RAGI, quantity: 3 },
    ];
    const stock = new Map([
      [NAVADHANYA, { stockQuantity: 20, trackInventory: true }], // 20/2 = 10
      [MILLET, { stockQuantity: 10, trackInventory: true }], // 10/1 = 10
      [RAGI, { stockQuantity: 8, trackInventory: true }], // 8/3 = 2 <- limiting
    ]);
    expect(calculateMaximumAvailableQuantity(components, stock)).toBe(2);
  });

  it("returns Infinity when every component is untracked (nothing constrains it)", () => {
    const components: ResolvedComponent[] = [{ productId: NAVADHANYA, quantity: 5 }];
    const stock = new Map([[NAVADHANYA, { stockQuantity: 0, trackInventory: false }]]);
    expect(calculateMaximumAvailableQuantity(components, stock)).toBe(Infinity);
  });

  it("returns 0 when a component is missing entirely", () => {
    const components: ResolvedComponent[] = [{ productId: "gone", quantity: 1 }];
    expect(calculateMaximumAvailableQuantity(components, new Map())).toBe(0);
  });
});

describe("consolidateComponents / mergeResolvedComponents (spec §13 — auto-consolidate duplicates)", () => {
  it("sums duplicate productIds rather than leaving them ambiguous", () => {
    const merged = consolidateComponents([component(NAVADHANYA, 2), component(NAVADHANYA, 3)]);
    expect(merged).toEqual([{ productId: NAVADHANYA, quantity: 5 }]);
  });

  it("merges several already-resolved requirement lists (e.g. a mixed pack selection, or a whole order)", () => {
    const merged = mergeResolvedComponents(
      [{ productId: NAVADHANYA, quantity: 20 }],
      [{ productId: NAVADHANYA, quantity: 10 }, { productId: MILLET, quantity: 5 }]
    );
    const byId = Object.fromEntries(merged.map((r) => [r.productId, r.quantity]));
    expect(byId[NAVADHANYA]).toBe(30);
    expect(byId[MILLET]).toBe(5);
  });
});
