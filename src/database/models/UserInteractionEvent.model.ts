import { Schema, model, Document, Types } from "mongoose";

export const INTERACTION_EVENT_TYPES = [
  "product_view",
  "category_view",
  "search",
  "search_result_click",
  "add_to_cart",
  "remove_from_cart",
  "wishlist_add",
  "wishlist_remove",
  "product_compare",
  "offer_view",
  "offer_accepted",
  "offer_rejected",
  "quantity_changed",
  "checkout_started",
  "purchase",
] as const;

export type InteractionEventType = (typeof INTERACTION_EVENT_TYPES)[number];

// Bump when the stored shape changes so old rows stay interpretable.
export const INTERACTION_SCHEMA_VERSION = 2;

export const INTERACTION_SOURCES = ["server", "client"] as const;
export type InteractionSource = (typeof INTERACTION_SOURCES)[number];

export interface InteractionMetadata {
  position?: number;
  resultCount?: number;
  // Where in the UI the interaction happened (search, category, cart, ...).
  surface?: string;
  relatedProductIds?: Types.ObjectId[];
}

export interface UserInteractionEventDocument extends Document {
  userId: Types.ObjectId;
  sessionId?: string;
  eventId: string;
  type: InteractionEventType;
  productId?: Types.ObjectId;
  categoryId?: Types.ObjectId;
  query?: string;
  quantity?: number;
  // Server-resolved or server-recorded (never client-supplied), INR.
  displayedPrice?: number;
  currency?: string;
  orderId?: Types.ObjectId;
  promotionId?: Types.ObjectId;
  // "server" = recorded at an authoritative business boundary (order, wishlist,
  // checkout). "client" = reported by the browser; lower trust.
  source: InteractionSource;
  correlationId?: string;
  metadata?: InteractionMetadata;
  // Best estimate of when it happened (a sane client clock, else receipt time).
  occurredAt: Date;
  // Trusted ingestion time (the spec's receivedAt).
  serverTs: Date;
  expiresAt: Date;
  consentVersion: number;
  schemaVersion: number;
}

// Append-only: rows are inserted and later deleted (TTL / user request),
// never updated. Authenticated users only - there is no anonymous visitor id.
const UserInteractionEventSchema = new Schema<UserInteractionEventDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Browser tab session; absent on server-recorded events.
    sessionId: { type: String },
    // Client-generated; unique per user so a retried request can't double-count.
    eventId: { type: String, required: true },
    type: { type: String, enum: INTERACTION_EVENT_TYPES, required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    query: { type: String },
    quantity: { type: Number },
    displayedPrice: { type: Number },
    currency: { type: String },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    promotionId: { type: Schema.Types.ObjectId, ref: "Coupon" },
    source: { type: String, enum: INTERACTION_SOURCES, required: true },
    correlationId: { type: String },
    metadata: {
      type: new Schema(
        {
          position: Number,
          resultCount: Number,
          surface: String,
          relatedProductIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
        },
        { _id: false }
      ),
    },
    occurredAt: { type: Date, required: true },
    serverTs: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    consentVersion: { type: Number, required: true },
    schemaVersion: { type: Number, required: true, default: INTERACTION_SCHEMA_VERSION },
  },
  { collection: "user_interaction_events", versionKey: false }
);

// eventId is the idempotency key: client events carry a client-generated id,
// server events a deterministic one (e.g. purchase = order + line), so a retry
// or a recovery sweep can never double-count.
// Idempotency + the per-user history read ({userId} prefix also serves the
// "delete all of a user's events" query).
UserInteractionEventSchema.index({ userId: 1, eventId: 1 }, { unique: true });
UserInteractionEventSchema.index({ userId: 1, serverTs: -1 });
// Aggregate analytics by event type over time.
UserInteractionEventSchema.index({ type: 1, serverTs: -1 });
// Retention: Mongo removes each row once its own expiresAt passes.
UserInteractionEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserInteractionEvent = model<UserInteractionEventDocument>(
  "UserInteractionEvent",
  UserInteractionEventSchema
);
