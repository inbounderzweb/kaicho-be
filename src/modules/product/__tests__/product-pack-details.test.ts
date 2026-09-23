import { describe, expect, it } from "vitest";
import { createProductSchema, updateProductSchema } from "../product.validation";

describe("product packaging details", () => {
  it("accepts weight and pack count together on update", () => {
    expect(updateProductSchema.parse({ weightPerPackGrams: 200, numberOfPacks: 3 })).toMatchObject({ weightPerPackGrams: 200, numberOfPacks: 3 });
  });
  it("accepts decimal grams and clearing old details", () => {
    expect(updateProductSchema.parse({ weightPerPackGrams: 125.5 }).weightPerPackGrams).toBe(125.5);
    expect(updateProductSchema.parse({ weightPerPackGrams: null, numberOfPacks: null })).toMatchObject({ weightPerPackGrams: null, numberOfPacks: null });
  });
  it.each([0, -1, 1.5])("rejects invalid pack count %s", (numberOfPacks) => {
    expect(updateProductSchema.safeParse({ numberOfPacks }).success).toBe(false);
  });
  it.each([0, -20])("rejects invalid weight %s", (weightPerPackGrams) => {
    expect(updateProductSchema.safeParse({ weightPerPackGrams }).success).toBe(false);
  });
  it("keeps packaging optional when creating existing-style products", () => {
    expect(createProductSchema.shape.weightPerPackGrams.safeParse(undefined).success).toBe(true);
    expect(createProductSchema.shape.numberOfPacks.safeParse(undefined).success).toBe(true);
  });
});
