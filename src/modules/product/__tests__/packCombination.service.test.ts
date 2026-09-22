import { describe, it, expect } from "vitest";
import {
  calculateCombinations,
  getApplicablePacks,
  resolveEffectivePackConfig,
  validateStock,
  calculatePackPrice,
  type CandidatePack,
  type EffectivePackConfig,
} from "../packCombination.service";

// Navadhanya-style config from the spec: 5/10/20, admin-priority, mixed
// packs allowed. Prices deliberately non-linear (10 isn't exactly 2x5, 20
// isn't exactly 2x10) so "does the engine actually read admin prices" is
// distinguishable from "does it just multiply the unit price".
function packs(overrides: Partial<CandidatePack>[] = []): CandidatePack[] {
  const base: CandidatePack[] = [
    { packId: "pack5", name: "Pack of 5", quantity: 5, price: 450, sortOrder: 0, isDefault: false },
    { packId: "pack10", name: "Pack of 10", quantity: 10, price: 850, sortOrder: 1, isDefault: false },
    { packId: "pack20", name: "Pack of 20", quantity: 20, price: 1600, sortOrder: 2, isDefault: false },
  ];
  overrides.forEach((o, i) => Object.assign(base[i], o));
  return base;
}

function totalQty(breakdown: { packQuantity: number; packCount: number }[]) {
  return breakdown.reduce((sum, l) => sum + l.packQuantity * l.packCount, 0);
}

describe("calculateCombinations — exact single-pack matches", () => {
  it.each([5, 10, 20])("quantity %i resolves to the matching single pack", (qty) => {
    const result = calculateCombinations(packs(), qty, {
      mixedPacksAllowed: true,
      strategy: "ADMIN_PRIORITY",
    });
    expect(result).not.toBeNull();
    expect(result!.exactMatch).toBe(true);
    expect(result!.breakdown).toHaveLength(1);
    expect(result!.breakdown[0].packQuantity).toBe(qty);
    expect(result!.totalQuantity).toBe(qty);
  });
});

describe("calculateCombinations — the spec's headline 50-unit scenario", () => {
  it("resolves 50 units to 20x2 + 10x1 (spec §5/§8)", () => {
    const result = calculateCombinations(packs(), 50, {
      mixedPacksAllowed: true,
      strategy: "ADMIN_PRIORITY",
    });
    expect(result).not.toBeNull();
    expect(result!.totalQuantity).toBe(50);
    expect(totalQty(result!.breakdown)).toBe(50);

    const byQty = new Map(result!.breakdown.map((l) => [l.packQuantity, l.packCount]));
    expect(byQty.get(20)).toBe(2);
    expect(byQty.get(10)).toBe(1);
    expect(result!.totalPrice).toBe(1600 * 2 + 850 * 1); // 4050, matches spec §8 exactly
  });

  it("computes the same total via calculatePackPrice", () => {
    const result = calculateCombinations(packs(), 50, {
      mixedPacksAllowed: true,
      strategy: "ADMIN_PRIORITY",
    })!;
    expect(calculatePackPrice(result.breakdown)).toBe(4050);
  });
});

describe("calculateCombinations — other bulk quantities (spec §24)", () => {
  it.each([15, 25, 30, 100])("finds a combination for %i units that sums exactly", (qty) => {
    const result = calculateCombinations(packs(), qty, {
      mixedPacksAllowed: true,
      strategy: "ADMIN_PRIORITY",
    });
    expect(result).not.toBeNull();
    expect(totalQty(result!.breakdown)).toBe(qty);
  });

  it("500 and 1000+ are not hard-coded away", () => {
    for (const qty of [500, 1000, 2500]) {
      const result = calculateCombinations(packs(), qty, {
        mixedPacksAllowed: true,
        strategy: "ADMIN_PRIORITY",
      });
      expect(result).not.toBeNull();
      expect(totalQty(result!.breakdown)).toBe(qty);
    }
  });
});

describe("calculateCombinations — strategies", () => {
  it("CHEAPEST picks the minimum-price combination even if it uses more packs", () => {
    // 15 via 10+5 = 850+450 = 1300, or 3x5 = 1350 — cheapest must pick 10+5.
    const result = calculateCombinations(packs(), 15, { mixedPacksAllowed: true, strategy: "CHEAPEST" });
    expect(result!.totalPrice).toBe(1300);
  });

  it("LARGEST_FIRST and SMALLEST_FIRST agree on the (count-minimal) packs used but order the breakdown by their own priority", () => {
    // For a "canonical" multiplicative denomination set like 5/10/20, the
    // minimum-pack-count solution is unique regardless of which pack is
    // tried first (greedy-largest-first is optimal for canonical coin
    // systems) — both strategies pick 20x1 + 5x1 for 25 units. Where they
    // genuinely differ is which pack leads the displayed breakdown.
    const largest = calculateCombinations(packs(), 25, { mixedPacksAllowed: true, strategy: "LARGEST_FIRST" });
    const smallest = calculateCombinations(packs(), 25, { mixedPacksAllowed: true, strategy: "SMALLEST_FIRST" });
    expect(totalQty(largest!.breakdown)).toBe(25);
    expect(totalQty(smallest!.breakdown)).toBe(25);
    expect(largest!.breakdown[0].packQuantity).toBe(20);
    expect(smallest!.breakdown[0].packQuantity).toBe(5);
  });

  it("MANUAL_ONLY never auto-combines beyond an exact match", () => {
    const exact = calculateCombinations(packs(), 10, { mixedPacksAllowed: true, strategy: "MANUAL_ONLY" });
    expect(exact).not.toBeNull();
    expect(exact!.exactMatch).toBe(true);

    const nonExact = calculateCombinations(packs(), 15, { mixedPacksAllowed: true, strategy: "MANUAL_ONLY" });
    expect(nonExact).toBeNull();
  });
});

describe("calculateCombinations — mixed packs disallowed (spec §9)", () => {
  it("only accepts an exact multiple of a single pack size", () => {
    // 50 = 10 x 5 (single pack size) — must NOT mix in a 20.
    const result = calculateCombinations(packs(), 50, { mixedPacksAllowed: false, strategy: "ADMIN_PRIORITY" });
    expect(result).not.toBeNull();
    expect(result!.breakdown).toHaveLength(1);
    expect(result!.breakdown[0].packQuantity * result!.breakdown[0].packCount).toBe(50);
  });

  it("rejects a quantity with no single-pack multiple", () => {
    // 7 isn't a multiple of 5, 10, or 20.
    const result = calculateCombinations(packs(), 7, { mixedPacksAllowed: false, strategy: "ADMIN_PRIORITY" });
    expect(result).toBeNull();
  });
});

describe("calculateCombinations — edge cases (spec §19)", () => {
  it("below the minimum configured pack falls back to null (no forced pack)", () => {
    const result = calculateCombinations(packs(), 3, { mixedPacksAllowed: true, strategy: "ADMIN_PRIORITY" });
    expect(result).toBeNull();
  });

  it("no valid combination for an unreachable quantity with mixed packs allowed", () => {
    const oddPacks: CandidatePack[] = [
      { packId: "p9", name: "Pack of 9", quantity: 9, price: 90, sortOrder: 0, isDefault: false },
      { packId: "p10", name: "Pack of 10", quantity: 10, price: 100, sortOrder: 1, isDefault: false },
    ];
    // 1 unit can't be made from 9s and 10s.
    const result = calculateCombinations(oddPacks, 1, { mixedPacksAllowed: true, strategy: "ADMIN_PRIORITY" });
    expect(result).toBeNull();
  });

  it("excludes inactive packs entirely", () => {
    const config: EffectivePackConfig = {
      source: "PRODUCT",
      mixedPacksAllowed: true,
      recommendationStrategy: "ADMIN_PRIORITY",
      packs: [
        { _id: "x" as never, name: "Pack of 10", quantity: 10, price: 850, sku: undefined, isActive: false, isDefault: false, sortOrder: 0, useComponentInventory: false, inventoryComponents: [] },
      ],
    };
    const applicable = getApplicablePacks(config, 10);
    expect(applicable).toHaveLength(0);
    const result = calculateCombinations(applicable, 10, { mixedPacksAllowed: true, strategy: "ADMIN_PRIORITY" });
    expect(result).toBeNull();
  });

  it("zero and negative quantities never produce a result", () => {
    expect(calculateCombinations(packs(), 0, { mixedPacksAllowed: true, strategy: "ADMIN_PRIORITY" })).toBeNull();
    expect(calculateCombinations(packs(), -5, { mixedPacksAllowed: true, strategy: "ADMIN_PRIORITY" })).toBeNull();
  });
});

describe("validateStock (spec §12)", () => {
  it("rejects a combination whose total units exceed available stock", () => {
    const result = calculateCombinations(packs(), 50, { mixedPacksAllowed: true, strategy: "ADMIN_PRIORITY" })!;
    expect(validateStock(result, 50)).toBe(true);
    expect(validateStock(result, 49)).toBe(false);
  });
});

describe("resolveEffectivePackConfig — Product > Category > disabled (spec §15/§16/§22)", () => {
  it("returns null for a product that never configured packs — today's exact behaviour", () => {
    const effective = resolveEffectivePackConfig({ packConfig: undefined }, null, "ADMIN_PRIORITY");
    expect(effective).toBeNull();
  });

  it("uses the product's own packs when mode is CUSTOM", () => {
    const effective = resolveEffectivePackConfig(
      {
        packConfig: {
          enabled: true,
          mode: "CUSTOM",
          mixedPacksAllowed: true,
          recommendationStrategy: "CHEAPEST",
          packs: packs().map((p) => ({ ...p, _id: p.packId as never, sku: undefined, isActive: true, useComponentInventory: false, inventoryComponents: [] })),
        },
      },
      null,
      "ADMIN_PRIORITY"
    );
    expect(effective?.source).toBe("PRODUCT");
    expect(effective?.recommendationStrategy).toBe("CHEAPEST");
  });

  it("falls back to the category's packs when mode is INHERIT_CATEGORY and the category has packs enabled", () => {
    const effective = resolveEffectivePackConfig(
      { packConfig: { enabled: true, mode: "INHERIT_CATEGORY", mixedPacksAllowed: true, recommendationStrategy: "ADMIN_PRIORITY", packs: [] } },
      { packConfig: { enabled: true, mixedPacksAllowed: false, recommendationStrategy: "LARGEST_FIRST", packs: packs().map((p) => ({ ...p, _id: p.packId as never, sku: undefined, isActive: true, useComponentInventory: false, inventoryComponents: [] })) } },
      "ADMIN_PRIORITY"
    );
    expect(effective?.source).toBe("CATEGORY");
    expect(effective?.mixedPacksAllowed).toBe(false);
    expect(effective?.recommendationStrategy).toBe("LARGEST_FIRST");
  });

  it("returns null when inheriting but the category has no packs enabled", () => {
    const effective = resolveEffectivePackConfig(
      { packConfig: { enabled: true, mode: "INHERIT_CATEGORY", mixedPacksAllowed: true, recommendationStrategy: "ADMIN_PRIORITY", packs: [] } },
      { packConfig: undefined },
      "ADMIN_PRIORITY"
    );
    expect(effective).toBeNull();
  });

  it("falls back to the global default strategy when the resolved config doesn't specify one", () => {
    const effective = resolveEffectivePackConfig(
      {
        packConfig: {
          enabled: true,
          mode: "CUSTOM",
          mixedPacksAllowed: true,
          recommendationStrategy: undefined as never,
          packs: [],
        },
      },
      null,
      "SMALLEST_FIRST"
    );
    expect(effective?.recommendationStrategy).toBe("SMALLEST_FIRST");
  });
});
