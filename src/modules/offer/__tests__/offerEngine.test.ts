import { describe, it, expect } from "vitest";
import {
  computeAutoAllocation,
  computeSelectionAllocation,
  type EngineLine,
  type OfferEngineRule,
} from "../offerEngine";

const rule = (over: Partial<OfferEngineRule> = {}): OfferEngineRule => ({
  buyQuantity: 1,
  maxFreeUnitsPerOrder: 1,
  minPaidUnitPriceMinor: 0,
  ...over,
});
const line = (productId: string, rupees: number, quantity: number): EngineLine => ({
  productId,
  unitPriceMinor: Math.round(rupees * 100),
  quantity,
});

describe("selection mode — the price rule (₹180 example)", () => {
  // The cart always holds the paid ₹180 item plus the candidate free item.
  it("₹180 paid + ₹180 free is valid", () => {
    const r = computeSelectionAllocation([line("A", 180, 2)], [{ productId: "A", quantity: 1 }], rule());
    expect(r.freeUnits).toBe(1);
    expect(r.discountMinor).toBe(18000);
    expect(r.rejected).toHaveLength(0);
  });

  it("₹180 paid + ₹150 free is valid", () => {
    const r = computeSelectionAllocation(
      [line("A", 180, 1), line("B", 150, 1)],
      [{ productId: "B", quantity: 1 }],
      rule()
    );
    expect(r.freeByProduct.get("B")).toBe(1);
    expect(r.discountMinor).toBe(15000);
  });

  it("₹180 paid + ₹100 free is valid", () => {
    const r = computeSelectionAllocation(
      [line("A", 180, 1), line("C", 100, 1)],
      [{ productId: "C", quantity: 1 }],
      rule()
    );
    expect(r.discountMinor).toBe(10000);
  });

  it("₹180 paid + ₹200 free is REJECTED and the ₹200 item stays paid", () => {
    const r = computeSelectionAllocation(
      [line("A", 180, 1), line("D", 200, 1)],
      [{ productId: "D", quantity: 1 }],
      rule()
    );
    expect(r.freeUnits).toBe(0);
    expect(r.discountMinor).toBe(0);
    expect(r.rejected).toEqual([expect.objectContaining({ productId: "D", reason: "PRICE_TOO_HIGH" })]);
  });

  it("₹180 paid + ₹250 free is REJECTED", () => {
    const r = computeSelectionAllocation(
      [line("A", 180, 1), line("E", 250, 1)],
      [{ productId: "E", quantity: 1 }],
      rule()
    );
    expect(r.freeUnits).toBe(0);
    expect(r.rejected[0].reason).toBe("PRICE_TOO_HIGH");
  });

  it("a lone selected unit has no paid partner → NOT_ENOUGH_PAID_ITEMS (no free without a paid unit)", () => {
    const r = computeSelectionAllocation([line("A", 180, 1)], [{ productId: "A", quantity: 1 }], rule());
    expect(r.freeUnits).toBe(0);
    expect(r.rejected[0].reason).toBe("NOT_ENOUGH_PAID_ITEMS");
  });

  it("a rejected pick goes back to the paid pool and can partner a cheaper pick", () => {
    // Customer ticked both; the ₹200 can't be free but IS a valid paid partner for the ₹100.
    const r = computeSelectionAllocation(
      [line("D", 200, 1), line("C", 100, 1)],
      [
        { productId: "D", quantity: 1 },
        { productId: "C", quantity: 1 },
      ],
      rule()
    );
    expect(r.freeByProduct.get("C")).toBe(1);
    expect(r.freeByProduct.get("D")).toBeUndefined();
    expect(r.discountMinor).toBe(10000);
  });

  it("a unit can never be both the free item and its own paid partner", () => {
    const r = computeSelectionAllocation([line("A", 180, 1)], [{ productId: "A", quantity: 1 }], rule());
    expect(r.freeUnits).toBe(0);
  });

  it("cannot pick more free units than are in the cart", () => {
    const r = computeSelectionAllocation([line("A", 180, 2)], [{ productId: "A", quantity: 5 }], rule({ maxFreeUnitsPerOrder: 5 }));
    expect(r.freeUnits).toBe(1);
    expect(r.rejected.some((x) => x.reason === "NOT_IN_CART")).toBe(true);
  });

  it("enforces the free-unit cap on selections", () => {
    const r = computeSelectionAllocation(
      [line("A", 180, 6)],
      [{ productId: "A", quantity: 3 }],
      rule({ maxFreeUnitsPerOrder: 2 })
    );
    expect(r.freeUnits).toBe(2);
    expect(r.limitReached).toBe(true);
    expect(r.rejected.some((x) => x.reason === "LIMIT_REACHED")).toBe(true);
  });

  it("honours the minimum purchased price for the PAID unit", () => {
    const r = computeSelectionAllocation(
      [line("A", 100, 1), line("B", 50, 1)],
      [{ productId: "B", quantity: 1 }],
      rule({ minPaidUnitPriceMinor: 15000 })
    );
    expect(r.freeUnits).toBe(0);
  });
});

describe("auto mode", () => {
  it("pairs a higher-priced paid unit with the next-cheaper one", () => {
    const r = computeAutoAllocation([line("A", 180, 1), line("B", 150, 1)], rule());
    expect(r.freeByProduct.get("B")).toBe(1);
    expect(r.discountMinor).toBe(15000);
  });

  it("never makes the most expensive unit free against a cheaper purchase", () => {
    const r = computeAutoAllocation([line("A", 100, 1), line("B", 250, 1)], rule());
    expect(r.freeByProduct.get("A")).toBe(1); // the ₹100 item, not the ₹250
    expect(r.discountMinor).toBe(10000);
  });

  it("same SKU in quantity 2 → 1 paid + 1 free", () => {
    const r = computeAutoAllocation([line("A", 180, 2)], rule());
    expect(r.freeByProduct.get("A")).toBe(1);
    expect(r.discountMinor).toBe(18000);
  });

  it("three eligible paid units with a cap of 2 yield at most 2 free units", () => {
    // 6 units in the cart = three valid pairs; the cap trims it to two.
    const r = computeAutoAllocation([line("A", 180, 6)], rule({ maxFreeUnitsPerOrder: 2 }));
    expect(r.freeUnits).toBe(2);
    expect(r.limitReached).toBe(true);
    expect(r.discountMinor).toBe(36000);
  });

  it("cap table: 1 unit → 0 free, 2 → 1, 4 → 2, 10 → still 2", () => {
    const freeFor = (units: number) => computeAutoAllocation([line("A", 100, units)], rule({ maxFreeUnitsPerOrder: 2 })).freeUnits;
    expect([freeFor(1), freeFor(2), freeFor(4), freeFor(10)]).toEqual([0, 1, 2, 2]);
  });

  it("no free unit without a qualifying paid unit", () => {
    const r = computeAutoAllocation([line("A", 180, 1)], rule());
    expect(r.freeUnits).toBe(0);
    expect(r.unitsToNextFree).toBe(1);
  });

  it("empty cart yields nothing", () => {
    const r = computeAutoAllocation([], rule());
    expect(r.freeUnits).toBe(0);
    expect(r.discountMinor).toBe(0);
  });

  it("buy 2 get 1: the free unit is the cheapest of each group of three", () => {
    const r = computeAutoAllocation([line("A", 300, 1), line("B", 200, 1), line("C", 100, 1)], rule({ buyQuantity: 2 }));
    expect(r.freeByProduct.get("C")).toBe(1);
    expect(r.discountMinor).toBe(10000);
  });

  it("minimum purchased price stops under-priced units from unlocking a free unit", () => {
    const r = computeAutoAllocation([line("A", 100, 2)], rule({ minPaidUnitPriceMinor: 15000 }));
    expect(r.freeUnits).toBe(0);
  });

  it("is deterministic regardless of line order", () => {
    const lines = [line("A", 180, 1), line("B", 180, 1), line("C", 90, 2)];
    const a = computeAutoAllocation(lines, rule({ maxFreeUnitsPerOrder: 5 }));
    const b = computeAutoAllocation([...lines].reverse(), rule({ maxFreeUnitsPerOrder: 5 }));
    expect([...a.freeByProduct.entries()].sort()).toEqual([...b.freeByProduct.entries()].sort());
    expect(a.discountMinor).toBe(b.discountMinor);
  });

  it("the discount never exceeds the sum of the free units' own prices and is never negative", () => {
    const lines = [line("A", 199.99, 3), line("B", 49.5, 3)];
    const r = computeAutoAllocation(lines, rule({ maxFreeUnitsPerOrder: 10 }));
    const total = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
    expect(r.discountMinor).toBeGreaterThan(0);
    expect(r.discountMinor).toBeLessThanOrEqual(total);
  });

  it("every pair has free price <= each paid price (property check)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      let x = seed;
      const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) =>
        line(`P${i}`, 10 + Math.floor(rnd() * 300), 1 + Math.floor(rnd() * 4))
      );
      const buy = 1 + Math.floor(rnd() * 3);
      const r = computeAutoAllocation(lines, rule({ buyQuantity: buy, maxFreeUnitsPerOrder: 1 + Math.floor(rnd() * 6) }));
      for (const pair of r.pairs) {
        for (const paid of pair.paid) expect(pair.freeUnitPriceMinor).toBeLessThanOrEqual(paid.unitPriceMinor);
        expect(pair.paid.reduce((s, p) => s + p.quantity, 0)).toBe(buy);
      }
      // No unit is used twice: free + paid units never exceed the cart.
      const used = r.pairs.reduce((s, p) => s + p.count * (1 + buy), 0);
      expect(used).toBeLessThanOrEqual(lines.reduce((s, l) => s + l.quantity, 0));
    }
  });
});
