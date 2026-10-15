import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderDocument } from "../../../database/models";

const state = vi.hoisted(() => ({ findById: vi.fn(), emit: vi.fn(), send: vi.fn() }));
vi.mock("../../../database/models", () => ({ User: { findById: state.findById } }));
vi.mock("../socket", () => ({ emitNewOrderNotification: state.emit }));
vi.mock("../email", () => ({ sendNewOrderEmail: state.send }));
import { notifyAdminsNewOrder } from "../notification.service";

const createdAt = new Date("2026-10-14T00:00:00.000Z");
const confirmedAt = new Date("2026-10-15T00:00:00.000Z");
const order = {
  _id: "order-id", userId: "customer-id", orderNumber: "ORD-100", createdAt,
  pricing: { grandTotal: 350 }, items: [{}], statusHistory: [{ status: "CONFIRMED", at: confirmedAt }],
} as unknown as OrderDocument;

beforeEach(() => {
  state.emit.mockReset();
  state.send.mockReset().mockResolvedValue(undefined);
  state.findById.mockReset().mockReturnValue({ select: () => ({ lean: async () => ({ firstName: "Customer" }) }) });
});

describe("admin notification channel independence", () => {
  it("includes the actual confirmation time for delayed online payments", async () => {
    await notifyAdminsNewOrder(order);
    expect(state.emit).toHaveBeenCalledWith(expect.objectContaining({ createdAt: createdAt.toISOString(), confirmedAt: confirmedAt.toISOString() }));
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("still sends email if the socket channel fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.emit.mockImplementation(() => { throw new Error("socket unavailable"); });
    await notifyAdminsNewOrder(order);
    expect(state.send).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("still alerts admins if the customer label lookup fails", async () => {
    state.findById.mockImplementation(() => { throw new Error("lookup unavailable"); });
    await notifyAdminsNewOrder(order);
    expect(state.emit).toHaveBeenCalledWith(expect.objectContaining({ customerName: "Customer" }));
    expect(state.send).toHaveBeenCalledTimes(1);
  });
});
