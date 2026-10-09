import { z } from "zod";
import { CLIENT_EVENT_TYPES, ruleViolation, isObjectId } from "./interaction.events";

export const MAX_EVENTS_PER_REQUEST = 20;
export const MAX_QUERY_LENGTH = 100;

const objectId = z.string().refine(isObjectId, "Invalid id");
const token = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid identifier");

// Strip control characters and collapse whitespace; a search query is
// free text typed by the user, so keep it short and inert.
const searchQuery = z
  .string()
  .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1).max(MAX_QUERY_LENGTH));

// Allowlist only - .strict() rejects any other key, so arbitrary client data
// can't be smuggled into the collection.
const metadata = z
  .object({
    position: z.number().int().min(0).max(1000),
    resultCount: z.number().int().min(0).max(1_000_000),
    surface: z.enum(["search", "category", "home", "product", "cart", "wishlist", "recommendation", "other"]),
    relatedProductIds: z.array(objectId).max(3),
  })
  .partial()
  .strict();

// Only types the server cannot observe itself may come from the browser.
// Wishlist changes, checkout and purchases are recorded server-side, so they
// are rejected here: accepting them too would double-count the action, and
// would let a user forge a purchase. Prices and order ids are never accepted -
// the server resolves them.
const eventSchema = z
  .object({
    eventId: token,
    sessionId: token,
    type: z.enum(CLIENT_EVENT_TYPES),
    productId: objectId.optional(),
    categoryId: objectId.optional(),
    query: searchQuery.optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
    promotionId: objectId.optional(),
    metadata: metadata.optional(),
    clientTs: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const problem = ruleViolation(e);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const recordInteractionsSchema = z
  .object({ events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_REQUEST) })
  .strict();

export const trackingConsentSchema = z.object({ granted: z.boolean() }).strict();

export type RecordInteractionsInput = z.infer<typeof recordInteractionsSchema>;
export type InteractionEventInput = RecordInteractionsInput["events"][number];
