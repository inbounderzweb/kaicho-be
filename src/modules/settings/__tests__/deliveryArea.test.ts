import { describe, it, expect } from "vitest";
import { isStateDeliverable, notServedMessage, resolveIndianState } from "../deliveryArea";

// Pure rules — no database.
const kerala = { restrictDeliveryToStates: true, serviceableStates: ["Kerala"] };
const open = { restrictDeliveryToStates: false, serviceableStates: [] };

describe("resolveIndianState", () => {
  it("matches canonical names, any case, spacing and punctuation", () => {
    expect(resolveIndianState("Kerala")).toBe("Kerala");
    expect(resolveIndianState("  kerala ")).toBe("Kerala");
    expect(resolveIndianState("TAMIL NADU")).toBe("Tamil Nadu");
    expect(resolveIndianState("Jammu & Kashmir")).toBe("Jammu and Kashmir");
    expect(resolveIndianState("Andaman & Nicobar Islands")).toBe("Andaman and Nicobar Islands");
  });
  it("maps common aliases and two-letter codes", () => {
    expect(resolveIndianState("KL")).toBe("Kerala");
    expect(resolveIndianState("rj")).toBe("Rajasthan");
    expect(resolveIndianState("Orissa")).toBe("Odisha");
    expect(resolveIndianState("New Delhi")).toBe("Delhi");
    expect(resolveIndianState("Pondicherry")).toBe("Puducherry");
  });
  it("returns null for unknown or empty input", () => {
    expect(resolveIndianState("Atlantis")).toBeNull();
    expect(resolveIndianState("")).toBeNull();
    expect(resolveIndianState(undefined)).toBeNull();
    expect(resolveIndianState("Kera")).toBeNull();
  });
});

describe("isStateDeliverable", () => {
  it("serves everything when the restriction is off", () => {
    expect(isStateDeliverable("Maharashtra", open)).toBe(true);
    expect(isStateDeliverable("whatever", open)).toBe(true);
  });
  it("serves only listed states when the restriction is on", () => {
    expect(isStateDeliverable("Kerala", kerala)).toBe(true);
    expect(isStateDeliverable("kerala", kerala)).toBe(true);
    expect(isStateDeliverable("KL", kerala)).toBe(true);
    expect(isStateDeliverable("Karnataka", kerala)).toBe(false);
  });
  it("fails closed for unknown or missing state text", () => {
    expect(isStateDeliverable("Atlantis", kerala)).toBe(false);
    expect(isStateDeliverable("", kerala)).toBe(false);
    expect(isStateDeliverable(null, kerala)).toBe(false);
  });
  it("names the served states and the customer's state in the message", () => {
    const m = notServedMessage("Karnataka", kerala);
    expect(m).toContain("only to Kerala");
    expect(m).toContain("Karnataka");
  });
});
