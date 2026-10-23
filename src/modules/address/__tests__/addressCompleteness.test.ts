import { describe, it, expect } from "vitest";
import { assertAddressComplete, findAddressProblems } from "../addressCompleteness";

// Pure — no database.
const good = {
  receiverName: "Asha Rao",
  receiverPhone: "9876543210",
  houseNo: "12",
  area: "MG Road",
  city: "Kochi",
  state: "Kerala",
  pincode: "682001",
};

describe("address completeness (checkout guard)", () => {
  it("accepts a complete address", () => {
    expect(findAddressProblems(good)).toEqual([]);
    expect(() => assertAddressComplete(good)).not.toThrow();
  });

  it("accepts a phone typed with spaces or +91 formatting", () => {
    expect(findAddressProblems({ ...good, receiverPhone: "98765 43210" })).toEqual([]);
  });

  it("reports every missing or invalid field", () => {
    const problems = findAddressProblems({ city: "", state: "", pincode: "12" });
    expect(problems).toEqual(
      expect.arrayContaining(["receiver name", "a valid mobile number", "house / flat number", "street / area", "city", "state", "a valid 6-digit pincode"])
    );
  });

  it("treats a legacy address (only city/state/pincode) as incomplete", () => {
    expect(findAddressProblems({ city: "Kochi", state: "Kerala", pincode: "682001" })).toEqual(
      expect.arrayContaining(["receiver name", "house / flat number", "street / area"])
    );
  });

  it("rejects bad pincodes and phones", () => {
    expect(findAddressProblems({ ...good, pincode: "012345" })).toContain("a valid 6-digit pincode");
    expect(findAddressProblems({ ...good, receiverPhone: "1234567890" })).toContain("a valid mobile number");
  });

  it("throws a 422 ADDRESS_INCOMPLETE that names what is missing", () => {
    try {
      assertAddressComplete({ ...good, receiverName: "", area: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 422, details: { code: "ADDRESS_INCOMPLETE" } });
      expect((err as Error).message).toContain("receiver name");
      expect((err as Error).message).toContain("street / area");
    }
  });
});
