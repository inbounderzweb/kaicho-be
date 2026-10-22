import { describe, it, expect } from "vitest";
import { evaluateOfferAgainstLines, type OfferScope } from "../offer.service";

// Pure — evaluateOfferAgainstLines needs no database.
const offer = {
  _id: { toString: () => "offer1" },
  name: "buy 1 get 1",
  description: null,
  buyQuantity: 1,
  maxFreeUnitsPerOrder: 4,
  minPaidUnitPrice: 0,
  allowCouponStacking: false,
  applyToAll: false,
  eligibleProductIds: [],
  eligibleCategoryIds: [],
  excludedProductIds: [],
  excludedCategoryIds: [],
} as never;

const ids = ["chicken", "broccoli", "navadhanya", "millet"];
const scope: OfferScope = {
  applyToAll: false,
  productIds: new Set(ids),
  categoryIds: new Set(),
  excludedProductIds: new Set(),
  excludedCategoryIds: new Set(),
};
const lines = [
  { productId: "chicken", categoryId: "c", unitPrice: 190, quantity: 1 },
  { productId: "broccoli", categoryId: "c", unitPrice: 180, quantity: 1 },
  { productId: "navadhanya", categoryId: "c", unitPrice: 140, quantity: 1 },
  { productId: "millet", categoryId: "c", unitPrice: 140, quantity: 1 },
];

describe("evaluateOfferAgainstLines — customer's free-item choice", () => {
  it("no preference → automatic: the two cheapest are free", () => {
    const r = evaluateOfferAgainstLines(offer, scope, lines);
    expect(r.freeUnits).toBe(2);
    expect(r.discountAmount).toBe(280);
  });

  it("an EMPTY choice (\"I'll choose\" with nothing picked) is treated as automatic, not as 'no free item'", () => {
    expect(evaluateOfferAgainstLines(offer, scope, lines, []).discountAmount).toBe(280);
    expect(evaluateOfferAgainstLines(offer, scope, lines, [{ productId: "navadhanya", quantity: 0 }]).discountAmount).toBe(280);
  });

  it("a real pick is honoured", () => {
    const r = evaluateOfferAgainstLines(offer, scope, lines, [{ productId: "navadhanya", quantity: 1 }]);
    expect(r.freeByProduct.get("navadhanya")).toBe(1);
    expect(r.discountAmount).toBe(140);
  });

  it("a pick for a product outside the offer is reported and the rest still applies", () => {
    const r = evaluateOfferAgainstLines(offer, scope, lines, [
      { productId: "other", quantity: 1 },
      { productId: "navadhanya", quantity: 1 },
    ]);
    expect(r.rejected.some((x) => x.productId === "other" && x.reason === "NOT_ELIGIBLE")).toBe(true);
    expect(r.discountAmount).toBe(140);
  });
});
