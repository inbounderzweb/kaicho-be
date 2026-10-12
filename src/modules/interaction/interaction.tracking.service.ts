import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { env } from "../../config/env";
import type { OrderDocument } from "../../database/models";
import { Order, User } from "../../database/models";
import {
  ruleViolation,
  type PreparedEvent,
  type TrackInput,
} from "./interaction.events";
import { enqueue, recordWriteStats } from "./interaction.buffer";
import { writeEvents } from "./interaction.persistence";
import { TRACKING_CONSENT_VERSION, type ConsentLike } from "./interaction.consent";

// THE shared entry point for recording interaction events on the server.
// Domain code calls this; nothing else writes to user_interaction_events.
//
// Contract: it NEVER throws into the caller. Tracking is secondary to the
// business action that triggered it - a failed or skipped event must not
// change the outcome of a cart, checkout or payment operation.

export interface TrackContext {
  userId: string;
  /** Already-loaded consent (e.g. from requireAuth). null = never answered. Omit to look it up. */
  consent?: ConsentLike | null;
  correlationId?: string;
}

async function resolveConsent(ctx: TrackContext): Promise<ConsentLike | null> {
  if (ctx.consent !== undefined) return ctx.consent;
  const user = await User.findById(ctx.userId).select("trackingConsent").lean();
  return user?.trackingConsent ?? null;
}

function prepare(ctx: TrackContext, input: TrackInput, consent: ConsentLike): PreparedEvent | null {
  const violation = ruleViolation(input);
  if (violation) {
    console.warn(`[interaction] dropped server event: ${violation}`);
    return null;
  }
  return {
    userId: ctx.userId,
    eventId: input.eventId ?? randomUUID(),
    type: input.type,
    source: "server",
    productId: input.productId,
    categoryId: input.categoryId,
    query: input.query,
    quantity: input.quantity,
    displayedPrice: input.displayedPrice,
    orderId: input.orderId,
    promotionId: input.promotionId,
    correlationId: ctx.correlationId,
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? new Date(),
    consentVersion: consent.version ?? TRACKING_CONSENT_VERSION,
  };
}

// Non-critical: buffered and batched. Resolves true when accepted.
async function track(ctx: TrackContext, input: TrackInput): Promise<boolean> {
  if (!env.interactionTrackingEnabled) return false;
  try {
    const consent = await resolveConsent(ctx);
    if (consent?.granted !== true) return false;
    const event = prepare(ctx, input, consent);
    return event ? enqueue(event) : false;
  } catch (err) {
    console.error("[interaction] track failed:", err instanceof Error ? err.message : "unknown error");
    return false;
  }
}

// Critical: written immediately (no buffer), so the caller - and the recovery
// sweep - know whether it landed. Still never throws; returns the outcome.
async function trackCritical(ctx: TrackContext, inputs: TrackInput[]): Promise<{ ok: boolean; written: number }> {
  if (!env.interactionTrackingEnabled) return { ok: true, written: 0 };
  try {
    const consent = await resolveConsent(ctx);
    if (consent?.granted !== true) return { ok: true, written: 0 };
    const events = inputs.map((i) => prepare(ctx, i, consent)).filter((e): e is PreparedEvent => e !== null);
    const result = await writeEvents(events, { requireKnownRefs: false });
    recordWriteStats(result);
    return { ok: true, written: result.written };
  } catch (err) {
    console.error("[interaction] critical track failed:", err instanceof Error ? err.message : "unknown error");
    return { ok: false, written: 0 };
  }
}

// ---- Order-derived events ---------------------------------------------------

// A purchase happens at the moment an order is first CONFIRMED (online: paid;
// COD: placed). One event per order line, with a deterministic id so the
// immediate call and the recovery sweep can both run without double counting.
// Consent must have been given BEFORE the purchase: opting in later does not
// retroactively record earlier orders.
function purchaseInputs(order: OrderDocument): TrackInput[] {
  const occurredAt = order.payment?.paidAt ?? order.createdAt;
  return order.items.map((item, index) => ({
    type: "purchase" as const,
    eventId: `p-${order._id.toString()}-${index}`,
    productId: item.productId.toString(),
    orderId: order._id.toString(),
    quantity: item.quantity,
    displayedPrice: item.unitPrice,
    occurredAt,
  }));
}

function consentCoversPurchase(consent: ConsentLike | null | undefined, order: OrderDocument): boolean {
  if (consent?.granted !== true) return false;
  const at = order.payment?.paidAt ?? order.createdAt;
  return !consent.updatedAt || consent.updatedAt.getTime() <= at.getTime();
}

async function trackPurchaseForOrder(order: OrderDocument, consent?: ConsentLike | null) {
  // Checked first so a disabled feature costs no consent lookup per order.
  if (!env.interactionTrackingEnabled) return { ok: true, written: 0 };
  const ctx: TrackContext = { userId: order.userId.toString(), correlationId: order.orderNumber };
  const resolved = consent !== undefined ? consent : await resolveConsent(ctx);
  if (!consentCoversPurchase(resolved, order)) return { ok: true, written: 0 };
  return trackCritical({ ...ctx, consent: resolved }, purchaseInputs(order));
}

function trackCheckoutStarted(order: OrderDocument): Promise<boolean> {
  return track(
    { userId: order.userId.toString(), correlationId: order.orderNumber },
    {
      type: "checkout_started",
      eventId: `co-${order._id.toString()}`,
      orderId: order._id.toString(),
      quantity: order.items.reduce((n, i) => n + i.quantity, 0),
      displayedPrice: order.pricing.grandTotal,
    }
  );
}

// ---- Recovery ---------------------------------------------------------------

const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECONCILE_MAX_ORDERS = 500;

// The order is the durable record of a purchase, so this re-derives purchase
// events for recently confirmed orders. It repairs the case where the process
// died (or the write failed) between confirming an order and recording its
// event. Idempotent: events that already exist are untouched.
export async function reconcilePurchaseEvents(now = new Date()): Promise<{ orders: number; written: number }> {
  if (!env.interactionTrackingEnabled) return { orders: 0, written: 0 };
  const orders = await Order.find({
    createdAt: { $gte: new Date(now.getTime() - RECONCILE_WINDOW_MS) },
    "statusHistory.status": "CONFIRMED",
  })
    .sort({ createdAt: -1 })
    .limit(RECONCILE_MAX_ORDERS)
    .exec();
  if (orders.length === 0) return { orders: 0, written: 0 };

  const userIds = [...new Set(orders.map((o) => o.userId.toString()))].map((id) => new Types.ObjectId(id));
  const users = await User.find({ _id: { $in: userIds } }).select("trackingConsent").lean();
  const consentByUser = new Map(users.map((u) => [u._id.toString(), u.trackingConsent ?? null]));

  let written = 0;
  for (const order of orders) {
    const result = await trackPurchaseForOrder(order, consentByUser.get(order.userId.toString()) ?? null);
    written += result.written;
  }
  return { orders: orders.length, written };
}

export const interactionTrackingService = {
  track,
  trackCritical,
  trackPurchaseForOrder,
  trackCheckoutStarted,
};
