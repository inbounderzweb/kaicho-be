import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure: the models are stubbed, so no database is touched.
const popupDocs: unknown[] = [];
const offerDocs: unknown[] = [];
vi.mock("../../../database/models", async (orig) => {
  const actual = await orig<typeof import("../../../database/models")>();
  return {
    ...actual,
    Popup: { find: () => ({ sort: () => ({ limit: () => ({ exec: async () => popupDocs }) }) }) },
    Offer: { find: () => ({ select: () => ({ lean: async () => offerDocs }) }), countDocuments: async () => 0 },
  };
});

import { listLivePopups } from "../popup.service";
import { crossFieldIssues, createPopupSchema } from "../popup.validation";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const hex = (n: number) => n.toString(16).padStart(24, "0");

function fakePopup(id: number, offerIds: number[] | number | null, over: Record<string, unknown> = {}) {
  const list = offerIds === null ? [] : Array.isArray(offerIds) ? offerIds : [offerIds];
  const object = {
    content: { heading: "BOGO", body: "" },
    design: { theme: "LIGHT", size: "MD" },
    devices: { desktop: { enabled: true, placement: "CENTER" }, mobile: { enabled: true, placement: "CENTER" } },
    timing: {}, display: {},
    countdown: { enabled: true, endsAt: new Date("2030-01-01T00:00:00Z"), label: "Hurry", position: "BOTTOM_CENTER" },
    targeting: { includePaths: [] },
    ...over,
  };
  return {
    _id: { toString: () => hex(id) },
    offerIds: list.map((n) => ({ toString: () => hex(n) })),
    offerId: null,
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    toObject: () => JSON.parse(JSON.stringify(object)),
  };
}
const offer = (id: number, over: Record<string, unknown> = {}) => ({
  _id: { toString: () => hex(id) },
  status: "ACTIVE",
  startsAt: null,
  endsAt: new Date("2026-10-25T18:30:00Z"),
  updatedAt: new Date("2026-10-21T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  popupDocs.length = 0;
  offerDocs.length = 0;
});

describe("popups linked to an offer", () => {
  it("an unlinked popup is untouched", async () => {
    popupDocs.push(fakePopup(1, null));
    const [p] = await listLivePopups(NOW);
    expect(p.linkedToOffer).toBe(false);
    expect(p.countdown.endsAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("a linked popup shows while its offer is live, with the timer ending when the offer ends", async () => {
    popupDocs.push(fakePopup(1, 9));
    offerDocs.push(offer(9));
    const [p] = await listLivePopups(NOW);
    expect(p.linkedToOffer).toBe(true);
    expect(p.countdown.enabled).toBe(true);
    expect(p.countdown.endsAt).toBe("2026-10-25T18:30:00.000Z");
    expect(p.countdown.label).toBe("Hurry");
  });

  it("the revision follows whichever changed last, so open pages pick up an edited offer", async () => {
    popupDocs.push(fakePopup(1, 9));
    offerDocs.push(offer(9, { updatedAt: new Date("2026-10-22T09:00:00Z") }));
    const [p] = await listLivePopups(NOW);
    expect(p.revision).toBe("2026-10-22T09:00:00.000Z");
  });

  it("disappears once the offer has ended, is disabled, hasn't started, or was deleted", async () => {
    popupDocs.push(fakePopup(1, 9), fakePopup(2, 8), fakePopup(3, 7), fakePopup(4, 6), fakePopup(5, 5));
    offerDocs.push(
      offer(9, { endsAt: new Date("2026-10-22T11:59:59Z") }), // ended
      offer(8, { status: "DISABLED" }),
      offer(7, { startsAt: new Date("2026-10-23T00:00:00Z") }), // not started
      offer(6) // still live
      // offer 5: deleted
    );
    const result = await listLivePopups(NOW);
    expect(result.map((p) => p.id)).toEqual([hex(4)]);
  });

  it("several offers: shown while ANY is live, timer to the soonest end among the live ones", async () => {
    popupDocs.push(fakePopup(1, [9, 8, 7]));
    offerDocs.push(
      offer(9, { endsAt: new Date("2026-10-30T00:00:00Z") }),
      offer(8, { endsAt: new Date("2026-10-24T00:00:00Z") }), // soonest live
      offer(7, { endsAt: new Date("2026-10-22T11:00:00Z") }) // already ended → ignored for the timer
    );
    const [p] = await listLivePopups(NOW);
    expect(p.countdown.endsAt).toBe("2026-10-24T00:00:00.000Z");
  });

  it("when the soonest offer ends the timer moves on to the next live one; the popup closes only when all have ended", async () => {
    popupDocs.push(fakePopup(1, [9, 8]));
    offerDocs.push(offer(9, { endsAt: new Date("2026-10-30T00:00:00Z") }), offer(8, { endsAt: new Date("2026-10-24T00:00:00Z") }));
    const after8 = new Date("2026-10-24T00:00:01Z");
    expect((await listLivePopups(after8))[0].countdown.endsAt).toBe("2026-10-30T00:00:00.000Z");
    expect(await listLivePopups(new Date("2026-10-30T00:00:01Z"))).toEqual([]);
  });

  it("a legacy single offerId link still works", async () => {
    const legacy = fakePopup(1, []);
    (legacy as { offerId: unknown }).offerId = { toString: () => hex(9) };
    popupDocs.push(legacy);
    offerDocs.push(offer(9));
    const [p] = await listLivePopups(NOW);
    expect(p.linkedToOffer).toBe(true);
    expect(p.countdown.endsAt).toBe("2026-10-25T18:30:00.000Z");
  });

  it("an offer with no end date has nothing to count down to", async () => {
    popupDocs.push(fakePopup(1, 9));
    offerDocs.push(offer(9, { endsAt: null }));
    const [p] = await listLivePopups(NOW);
    expect(p.countdown.enabled).toBe(false);
    expect(p.countdown.endsAt).toBeNull();
  });
});

describe("validation with an offer link", () => {
  it("a timer normally needs an end time", () => {
    expect(crossFieldIssues({ countdown: { enabled: true, endsAt: null } }).length).toBe(1);
  });
  it("…but not when the popup is linked to offers", () => {
    expect(crossFieldIssues({ countdown: { enabled: true, endsAt: null }, offerIds: [hex(9)] })).toEqual([]);
  });
  it("offer ids must look like ids", () => {
    const base = { name: "x" } as Record<string, unknown>;
    expect(createPopupSchema.safeParse({ ...base, offerIds: ["nope"] }).success).toBe(false);
  });
});
