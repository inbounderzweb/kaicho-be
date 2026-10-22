import { describe, expect, it } from "vitest";
import { DESKTOP_PLACEMENTS, Popup } from "../../../database/models/Popup.model";
import { toPublicPopupDto } from "../popup.service";
import { createPopupSchema } from "../popup.validation";

function draft() {
  const doc = new Popup({
    name: "Device banners",
    content: { desktopImageUrl: "/desktop.jpg", mobileImageUrl: "/mobile.jpg" },
    design: { imageOnly: true },
    updatedAt: new Date("2030-01-01T00:00:00Z"),
  });
  const { content, design, devices, timing, display, countdown, targeting } = toPublicPopupDto(doc);
  return { name: doc.name, priority: doc.priority, content, design, devices, timing, display, countdown, targeting, schedule: {} };
}

describe("device banner configuration", () => {
  it("retains separate device images through model storage, public DTO and input validation", () => {
    const input = createPopupSchema.parse(draft());
    expect(input.content).toMatchObject({ desktopImageUrl: "/desktop.jpg", mobileImageUrl: "/mobile.jpg" });
    expect(input.content.imageUrl).toBeUndefined();
    expect(input.design.imageOnly).toBe(true);
  });

  it("accepts all nine desktop positions while retaining the mobile bottom sheet", async () => {
    for (const placement of DESKTOP_PLACEMENTS) {
      const input = draft();
      input.devices.desktop.placement = placement;
      expect(createPopupSchema.parse(input).devices.desktop.placement).toBe(placement);
      const doc = new Popup({ ...input, updatedAt: new Date("2030-01-01T00:00:00Z") });
      await expect(doc.validate()).resolves.toBeUndefined();
      expect(toPublicPopupDto(doc).devices.mobile.placement).toBe("BOTTOM_SHEET");
    }
  });

  it("rejects desktop-only positions on mobile and unsafe device image URLs", () => {
    const input = draft();
    const invalidMobile = { ...input, devices: { ...input.devices, mobile: { enabled: true, placement: "TOP_RIGHT" } } };
    expect(createPopupSchema.safeParse(invalidMobile).success).toBe(false);
    input.content.desktopImageUrl = "javascript:alert(1)";
    expect(createPopupSchema.safeParse(input).success).toBe(false);
  });
});
