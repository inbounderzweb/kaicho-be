import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Order,
  OrderDocument,
  OrderStatus,
  ShipmentStatus,
  ORDER_STATUS_TRANSITIONS,
} from "../../database/models";
import { toOrderDto } from "./order.service";
import type { SaveShipmentInput } from "./order.validation";

// Shipment handling lives in its own file rather than order.service.ts because
// it is the seam a courier aggregator (Shiprocket etc.) will plug into: today
// `saveShipment` just records what an admin typed, tomorrow it can call an
// aggregator client, stamp `provider`, and store the returned AWB/label — with
// no change to the order lifecycle, which stays the single source of truth for
// anything money- or stock-related.

// Order statuses a shipment can legitimately attach to. An unpaid order has
// nothing to ship yet; a cancelled / returned / refunded one is finished.
const SHIPPABLE_ORDER_STATUSES: OrderStatus[] = [
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURN_REQUESTED",
];

// The linear fulfilment happy-path. `advanceOrderStatusAlongSequence` only ever
// walks *forward* along this list and re-checks every hop against the canonical
// transition table, so a shipment update can never drag an order backward or
// sideways into CANCELLED / RETURN_* / REFUNDED.
const FULFILMENT_SEQUENCE: OrderStatus[] = [
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

// Which order status a given shipment status implies. CANCELLED and
// FAILED_DELIVERY are intentionally unmapped — a failed delivery attempt or a
// cancelled parcel never moves the order lifecycle on its own.
const SHIPMENT_TO_ORDER_STATUS: Partial<Record<ShipmentStatus, OrderStatus>> = {
  ORDER_CONFIRMED: "CONFIRMED",
  PROCESSING: "PROCESSING",
  PACKED: "PROCESSING",
  SHIPPED: "SHIPPED",
  IN_TRANSIT: "SHIPPED",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
};

const SHIPPED_LIKE: ShipmentStatus[] = ["SHIPPED", "IN_TRANSIT", "OUT_FOR_DELIVERY"];

function humanizeStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, " ");
}

function advanceOrderStatusAlongSequence(
  doc: OrderDocument,
  target: OrderStatus,
  actorId?: string
): void {
  const currentIdx = FULFILMENT_SEQUENCE.indexOf(doc.status);
  const targetIdx = FULFILMENT_SEQUENCE.indexOf(target);
  // Off the happy-path (CANCELLED, RETURN_REQUESTED, …) or not a forward move —
  // leave the order status alone.
  if (currentIdx === -1 || targetIdx === -1 || targetIdx <= currentIdx) return;

  for (let i = currentIdx + 1; i <= targetIdx; i++) {
    const next = FULFILMENT_SEQUENCE[i];
    if (!ORDER_STATUS_TRANSITIONS[doc.status].includes(next)) break;
    doc.status = next;
    doc.statusHistory.push({
      status: next,
      at: new Date(),
      note: "Auto-updated from shipment",
      actor: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
    });
  }
}

async function loadOrderOr404(orderId: string): Promise<OrderDocument> {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new AppError("Order not found", 404);
  }
  const doc = await Order.findById(orderId).exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }
  return doc;
}

// Create-or-update the shipment. One endpoint covers both because "add tracking"
// and "correct a typo in the AWB" are the same admin gesture — `carrier` and
// `trackingNumber` are only mandatory on the first save.
export async function saveShipment(
  orderId: string,
  actorId: string | undefined,
  input: SaveShipmentInput
) {
  const doc = await loadOrderOr404(orderId);

  if (!SHIPPABLE_ORDER_STATUSES.includes(doc.status)) {
    throw new AppError(`This order can't be shipped while it is ${humanizeStatus(doc.status)}`, 409);
  }

  const prev = doc.shipment;
  const creating = !prev;
  if (creating && (!input.carrier || !input.trackingNumber)) {
    throw new AppError("Courier name and tracking number are required to create a shipment", 400);
  }

  const nextStatus: ShipmentStatus = input.status ?? prev?.status ?? "SHIPPED";
  const now = new Date();

  const shipment = {
    carrier: input.carrier ?? prev?.carrier ?? "",
    trackingNumber: input.trackingNumber ?? prev?.trackingNumber ?? "",
    shipmentId: input.shipmentId ?? prev?.shipmentId,
    status: nextStatus,
    shippedAt: input.shippedAt ?? prev?.shippedAt,
    estimatedDeliveryAt: input.estimatedDeliveryAt ?? prev?.estimatedDeliveryAt,
    deliveredAt: prev?.deliveredAt,
    trackingUrl: input.trackingUrl ?? prev?.trackingUrl,
    provider: prev?.provider ?? "manual",
    history: [...(prev?.history ?? [])],
    notes: input.notes ?? prev?.notes,
  };

  // Keep the shipped / delivered timestamps coherent with the status.
  if (SHIPPED_LIKE.includes(nextStatus) && !shipment.shippedAt) shipment.shippedAt = now;
  if (nextStatus === "DELIVERED" && !shipment.deliveredAt) shipment.deliveredAt = now;

  const statusChanged = creating || prev?.status !== nextStatus;
  if (statusChanged) {
    shipment.history.push({ status: nextStatus, at: now, note: input.notes });
  }

  doc.set("shipment", shipment);

  const targetOrderStatus = SHIPMENT_TO_ORDER_STATUS[nextStatus];
  if (targetOrderStatus) advanceOrderStatusAlongSequence(doc, targetOrderStatus, actorId);

  await doc.save();
  return toOrderDto(doc);
}

// Quick status-only update once a shipment exists — the courier moves the
// parcel, the admin (or later, a courier webhook) records the step.
export async function updateShipmentStatus(
  orderId: string,
  actorId: string | undefined,
  status: ShipmentStatus,
  note?: string
) {
  const doc = await loadOrderOr404(orderId);
  if (!doc.shipment) {
    throw new AppError("Add shipment details before updating the shipping status", 409);
  }

  const now = new Date();
  doc.shipment.status = status;
  if (SHIPPED_LIKE.includes(status) && !doc.shipment.shippedAt) doc.shipment.shippedAt = now;
  if (status === "DELIVERED" && !doc.shipment.deliveredAt) doc.shipment.deliveredAt = now;
  doc.shipment.history.push({ status, at: now, note });

  const targetOrderStatus = SHIPMENT_TO_ORDER_STATUS[status];
  if (targetOrderStatus) advanceOrderStatusAlongSequence(doc, targetOrderStatus, actorId);

  await doc.save();
  return toOrderDto(doc);
}
