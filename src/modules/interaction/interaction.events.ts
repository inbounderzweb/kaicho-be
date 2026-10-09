import { Types } from "mongoose";
import type { InteractionEventType } from "../../database/models";

// ---- Central event rules ----------------------------------------------------
// One table drives validation for BOTH ingestion paths (browser batches and
// server-side business boundaries), so a rule can't drift between them.
//
// trust:
//   "server" - recorded only where the server itself observes the outcome
//              (wishlist change, order created, order paid). The browser may
//              NOT send these, otherwise the same action would be counted
//              twice, and a user could forge purchases.
//   "client" - the server cannot observe it (public cached pages, the
//              client-side cart), so the browser reports it. Lower trust.

type Need = "required" | "optional" | "none";

export interface EventRule {
  trust: "server" | "client";
  product: Need;
  category: Need;
  query: Need;
  order: Need;
  // Fill displayedPrice from the CURRENT catalog price (server-side lookup)
  // when the event doesn't already carry a trusted one.
  enrichPrice?: boolean;
}

const N = "none" as const;
const R = "required" as const;
const O = "optional" as const;

export const EVENT_RULES: Record<InteractionEventType, EventRule> = {
  product_view: { trust: "client", product: R, category: O, query: N, order: N, enrichPrice: true },
  category_view: { trust: "client", product: N, category: R, query: N, order: N },
  search: { trust: "client", product: N, category: N, query: R, order: N },
  search_result_click: { trust: "client", product: R, category: O, query: R, order: N },
  add_to_cart: { trust: "client", product: R, category: O, query: N, order: N, enrichPrice: true },
  remove_from_cart: { trust: "client", product: R, category: O, query: N, order: N, enrichPrice: true },
  quantity_changed: { trust: "client", product: R, category: O, query: N, order: N, enrichPrice: true },
  product_compare: { trust: "client", product: R, category: O, query: N, order: N },
  offer_view: { trust: "client", product: O, category: N, query: N, order: N },
  wishlist_add: { trust: "server", product: R, category: O, query: N, order: N, enrichPrice: true },
  wishlist_remove: { trust: "server", product: R, category: O, query: N, order: N },
  offer_accepted: { trust: "server", product: O, category: N, query: N, order: N },
  offer_rejected: { trust: "server", product: O, category: N, query: N, order: N },
  checkout_started: { trust: "server", product: N, category: N, query: N, order: R },
  purchase: { trust: "server", product: R, category: O, query: N, order: R },
};

export const CLIENT_EVENT_TYPES = (Object.keys(EVENT_RULES) as InteractionEventType[]).filter(
  (t) => EVENT_RULES[t].trust === "client"
) as [InteractionEventType, ...InteractionEventType[]];

export const isObjectId = (v: unknown): v is string =>
  typeof v === "string" && v.length === 24 && Types.ObjectId.isValid(v);

export interface EventMetadata {
  position?: number;
  resultCount?: number;
  surface?: string;
  relatedProductIds?: string[];
}

// ---- Shapes -----------------------------------------------------------------

export interface TrackInput {
  type: InteractionEventType;
  /** Deterministic for events that must never double-count (purchase). */
  eventId?: string;
  productId?: string;
  categoryId?: string;
  query?: string;
  quantity?: number;
  /** Only trusted server values (e.g. the order's unit price). */
  displayedPrice?: number;
  orderId?: string;
  promotionId?: string;
  occurredAt?: Date;
  metadata?: EventMetadata;
}

// A validated, normalised event, ready to persist.
export interface PreparedEvent {
  userId: string;
  eventId: string;
  type: InteractionEventType;
  source: "server" | "client";
  sessionId?: string;
  productId?: string;
  categoryId?: string;
  query?: string;
  quantity?: number;
  displayedPrice?: number;
  currency?: string;
  orderId?: string;
  promotionId?: string;
  correlationId?: string;
  metadata?: EventMetadata;
  occurredAt: Date;
  consentVersion: number;
}

function check(need: Need, present: boolean, label: string, type: string): string | null {
  if (need === "required" && !present) return `${type} requires ${label}`;
  if (need === "none" && present) return `${type} must not include ${label}`;
  return null;
}

// Returns a problem description, or null when the event matches its rule.
export function ruleViolation(input: TrackInput): string | null {
  const rule = EVENT_RULES[input.type];
  if (!rule) return `unknown event type ${String(input.type)}`;
  return (
    check(rule.product, Boolean(input.productId), "productId", input.type) ??
    check(rule.category, Boolean(input.categoryId), "categoryId", input.type) ??
    check(rule.query, Boolean(input.query), "query", input.type) ??
    check(rule.order, Boolean(input.orderId), "orderId", input.type)
  );
}
