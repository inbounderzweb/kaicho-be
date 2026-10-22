import { describe, it, expect, vi, beforeEach } from "vitest";

const getDoc = vi.fn();
vi.mock("../settings.service", () => ({ getStoreSettingsDoc: () => getDoc() }));

import { assertStateDeliverable } from "../deliveryArea";

// The checkout guard, with the settings document stubbed (no database).
describe("assertStateDeliverable (checkout guard)", () => {
  beforeEach(() => getDoc.mockReset());

  it("lets every state through when the restriction is off", async () => {
    getDoc.mockResolvedValue({ restrictDeliveryToStates: false, serviceableStates: [] });
    await expect(assertStateDeliverable("Karnataka")).resolves.toBeUndefined();
  });

  it("allows an address inside the delivery areas (any spelling)", async () => {
    getDoc.mockResolvedValue({ restrictDeliveryToStates: true, serviceableStates: ["Rajasthan"] });
    await expect(assertStateDeliverable("rajasthan")).resolves.toBeUndefined();
    await expect(assertStateDeliverable("RJ")).resolves.toBeUndefined();
  });

  it("refuses an address outside the delivery areas with a 422 and a clear message", async () => {
    getDoc.mockResolvedValue({ restrictDeliveryToStates: true, serviceableStates: ["Rajasthan"] });
    await expect(assertStateDeliverable("Kerala")).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("only to Rajasthan"),
      details: { code: "DELIVERY_AREA_NOT_SERVED" },
    });
  });

  it("refuses an unrecognised or missing state while restricted", async () => {
    getDoc.mockResolvedValue({ restrictDeliveryToStates: true, serviceableStates: ["Rajasthan"] });
    await expect(assertStateDeliverable("Atlantis")).rejects.toMatchObject({ statusCode: 422 });
    await expect(assertStateDeliverable("")).rejects.toMatchObject({ statusCode: 422 });
  });
});
