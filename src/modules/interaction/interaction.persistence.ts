import { Types, type AnyBulkWriteOperation } from "mongoose";
import { env } from "../../config/env";
import {
  Category,
  Product,
  UserInteractionEvent,
  INTERACTION_SCHEMA_VERSION,
  type UserInteractionEventDocument,
} from "../../database/models";
import { EVENT_RULES, type PreparedEvent } from "./interaction.events";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WriteResult {
  written: number;
  duplicates: number;
  /** Events dropped because they referenced a product/category that does not exist. */
  rejected: number;
}

// The ONE place interaction events are persisted. Resolves references for the
// whole batch in a single product query (category + current price) and a
// single category query, then upserts keyed on (userId, eventId): retries,
// double-fires and recovery sweeps are no-ops, while two genuinely separate
// actions (different eventIds) are both kept.
export async function writeEvents(
  events: PreparedEvent[],
  opts: { requireKnownRefs: boolean }
): Promise<WriteResult> {
  if (events.length === 0) return { written: 0, duplicates: 0, rejected: 0 };

  const productIds = new Set<string>();
  const categoryIds = new Set<string>();
  for (const e of events) {
    if (e.productId) productIds.add(e.productId);
    if (e.categoryId) categoryIds.add(e.categoryId);
    e.metadata?.relatedProductIds?.forEach((id) => productIds.add(id));
  }

  const [products, categories] = await Promise.all([
    productIds.size
      ? Product.find({ _id: { $in: [...productIds] } }).select("categoryId pricing.sellingPrice").lean()
      : [],
    opts.requireKnownRefs && categoryIds.size
      ? Category.find({ _id: { $in: [...categoryIds] } }).select("_id").lean()
      : [],
  ]);
  const productInfo = new Map(
    products.map((p) => [p._id.toString(), { categoryId: p.categoryId?.toString(), price: p.pricing?.sellingPrice }])
  );
  const knownCategories = new Set(categories.map((c) => c._id.toString()));

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.interactionRetentionDays * DAY_MS);
  const ops: AnyBulkWriteOperation<UserInteractionEventDocument>[] = [];
  let rejected = 0;

  for (const e of events) {
    const product = e.productId ? productInfo.get(e.productId) : undefined;
    if (opts.requireKnownRefs) {
      if ((e.productId && !product) || (e.categoryId && !knownCategories.has(e.categoryId))) {
        rejected += 1;
        continue;
      }
    }
    const categoryId = e.categoryId ?? product?.categoryId;
    const price =
      e.displayedPrice ?? (EVENT_RULES[e.type].enrichPrice && product?.price != null ? product.price : undefined);
    const related = e.metadata?.relatedProductIds?.filter((id) => productInfo.has(id));
    const uid = new Types.ObjectId(e.userId);

    // userId/eventId come from the upsert filter. Mongoose casts the string
    // ids to ObjectIds on bulkWrite; the driver typings only know the
    // document's ObjectId fields, hence the cast below.
    const insert = {
      type: e.type,
      source: e.source,
      ...(e.sessionId && { sessionId: e.sessionId }),
      ...(e.productId && { productId: e.productId }),
      ...(categoryId && { categoryId }),
      ...(e.query && { query: e.query }),
      ...(e.quantity !== undefined && { quantity: e.quantity }),
      ...(price !== undefined && { displayedPrice: price, currency: e.currency ?? "INR" }),
      ...(e.orderId && { orderId: e.orderId }),
      ...(e.promotionId && { promotionId: e.promotionId }),
      ...(e.correlationId && { correlationId: e.correlationId }),
      ...(e.metadata && { metadata: { ...e.metadata, ...(related && { relatedProductIds: related }) } }),
      occurredAt: e.occurredAt,
      serverTs: now,
      expiresAt,
      consentVersion: e.consentVersion,
      schemaVersion: INTERACTION_SCHEMA_VERSION,
    };
    ops.push({
      updateOne: {
        filter: { userId: uid, eventId: e.eventId },
        update: { $setOnInsert: insert as never },
        upsert: true,
      },
    });
  }

  let written = 0;
  if (ops.length) {
    const result = await UserInteractionEvent.bulkWrite(ops, { ordered: false });
    written = result.upsertedCount;
  }
  return { written, duplicates: ops.length - written, rejected };
}
