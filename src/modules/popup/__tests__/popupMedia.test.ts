import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure: models and the media service are stubbed — no database.
const mediaByFolder = new Map<string, string>();
let usages: { mediaId: { toString(): string }; field: string }[] = [];
const attach = vi.fn(async (..._args: unknown[]) => ({}));
const detach = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../../../database/models", async (orig) => {
  const actual = await orig<typeof import("../../../database/models")>();
  return {
    ...actual,
    Media: {
      findOne: (q: { "variants.optimized.key": { $regex: string } }) => ({
        select: () => ({
          lean: async () => {
            const folder = q["variants.optimized.key"].$regex.replace(/\//g, "");
            const id = mediaByFolder.get(folder);
            return id ? { _id: { toString: () => id } } : null;
          },
        }),
      }),
    },
    MediaUsage: { find: () => ({ lean: async () => usages }) },
  };
});
vi.mock("../../media/media.service", () => ({ attachMediaToEntity: (...a: unknown[]) => attach(...a), detachMedia: (...a: unknown[]) => detach(...a) }));

import { syncPopupMedia } from "../popup.service";

const UUID = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const url = (n: number) => `https://cdn.example/production/images/2026/10/${UUID(n)}/optimized.webp`;

beforeEach(() => {
  mediaByFolder.clear();
  usages = [];
  attach.mockClear();
  detach.mockClear();
});

describe("popup banners are registered as used media (so cleanup can't delete them)", () => {
  it("attaches the shared, desktop and mobile banners to the popup", async () => {
    mediaByFolder.set(UUID(1), "m1");
    mediaByFolder.set(UUID(2), "m2");
    mediaByFolder.set(UUID(3), "m3");
    await syncPopupMedia("popup1", { heading: "", body: "", imageUrl: url(1), desktopImageUrl: url(2), mobileImageUrl: url(3) } as never);
    expect(attach).toHaveBeenCalledWith("m1", "POPUP", "popup1", { field: "image" });
    expect(attach).toHaveBeenCalledWith("m2", "POPUP", "popup1", { field: "desktopImage" });
    expect(attach).toHaveBeenCalledWith("m3", "POPUP", "popup1", { field: "mobileImage" });
    expect(detach).not.toHaveBeenCalled();
  });

  it("releases a banner that was replaced or removed", async () => {
    mediaByFolder.set(UUID(5), "m5");
    usages = [
      { mediaId: { toString: () => "mOld" }, field: "mobileImage" }, // replaced
      { mediaId: { toString: () => "mGone" }, field: "desktopImage" }, // removed
    ];
    await syncPopupMedia("popup1", { heading: "", body: "", mobileImageUrl: url(5) } as never);
    expect(detach).toHaveBeenCalledWith("mOld", { entityType: "POPUP", entityId: "popup1", field: "mobileImage" });
    expect(detach).toHaveBeenCalledWith("mGone", { entityType: "POPUP", entityId: "popup1", field: "desktopImage" });
    expect(attach).toHaveBeenCalledWith("m5", "POPUP", "popup1", { field: "mobileImage" });
  });

  it("ignores URLs that aren't library uploads and keeps an unchanged banner attached", async () => {
    mediaByFolder.set(UUID(7), "m7");
    usages = [{ mediaId: { toString: () => "m7" }, field: "image" }];
    await syncPopupMedia("popup1", { heading: "", body: "", imageUrl: url(7), desktopImageUrl: "https://elsewhere.test/banner.png" } as never);
    expect(detach).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
