import { describe, it, expect } from "vitest";
import { updateStoreSettingsSchema } from "../settings.validation";
import { INDIAN_STATES } from "../../../database/models";

// Pure validation — no database.
describe("delivery-area settings validation", () => {
  it("accepts a restriction with known states and collapses duplicates", () => {
    const parsed = updateStoreSettingsSchema.parse({ restrictDeliveryToStates: true, serviceableStates: ["Kerala", "Kerala", "Tamil Nadu"] });
    expect(parsed.serviceableStates).toEqual(["Kerala", "Tamil Nadu"]);
    expect(parsed.restrictDeliveryToStates).toBe(true);
  });

  it("rejects unknown or misspelt states", () => {
    expect(updateStoreSettingsSchema.safeParse({ serviceableStates: ["Keralaa"] }).success).toBe(false);
    expect(updateStoreSettingsSchema.safeParse({ serviceableStates: ["Atlantis"] }).success).toBe(false);
  });

  it("rejects turning the restriction on with an empty list", () => {
    const r = updateStoreSettingsSchema.safeParse({ restrictDeliveryToStates: true, serviceableStates: [] });
    expect(r.success).toBe(false);
  });

  it("allows turning the restriction off and clearing the list", () => {
    expect(updateStoreSettingsSchema.safeParse({ restrictDeliveryToStates: false, serviceableStates: [] }).success).toBe(true);
    expect(updateStoreSettingsSchema.safeParse({ restrictDeliveryToStates: false }).success).toBe(true);
  });

  it("rejects non-boolean flag values and non-array lists", () => {
    expect(updateStoreSettingsSchema.safeParse({ restrictDeliveryToStates: "true" }).success).toBe(false);
    expect(updateStoreSettingsSchema.safeParse({ serviceableStates: "Kerala" }).success).toBe(false);
  });

  it("exposes 36 states and union territories including Kerala", () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(INDIAN_STATES).toContain("Kerala");
  });
});
