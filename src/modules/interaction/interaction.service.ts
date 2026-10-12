import { Types } from "mongoose";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import { UserInteractionEvent } from "../../database/models";
import type { PreparedEvent } from "./interaction.events";
import { writeEvents } from "./interaction.persistence";
import { recordWriteStats, purgeBufferedForUser } from "./interaction.buffer";
import { getTrackingConsent, TRACKING_CONSENT_VERSION, type ConsentState, type ConsentLike } from "./interaction.consent";
import type { InteractionEventInput } from "./interaction.validation";

export { getTrackingConsent, setTrackingConsent, TRACKING_CONSENT_VERSION } from "./interaction.consent";

const DAY_MS = 24 * 60 * 60 * 1000;
// A client clock further off than this from the server is ignored (the
// trusted receipt time is used for occurredAt instead).
const MAX_CLIENT_CLOCK_SKEW_MS = DAY_MS;

export interface RecordResult {
  tracking: "enabled" | "disabled";
  recorded: number;
  duplicates: number;
  rejected: number;
}

// Browser-reported events (the server can't observe public page views or the
// client-side cart). Same persistence path as server events, marked
// source:"client". Never throws on bad references - a stale product id in a
// client's queue must not fail a batch of otherwise valid events.
export async function recordInteractions(
  userId: string,
  events: InteractionEventInput[],
  // requireAuth has already read the user; pass its consent to avoid a
  // second query on this hot path. null = the user has never answered.
  knownConsent?: ConsentLike | null,
  correlationId?: string
): Promise<RecordResult> {
  if (!env.interactionTrackingEnabled) {
    return { tracking: "disabled", recorded: 0, duplicates: 0, rejected: 0 };
  }
  const consent: ConsentState =
    knownConsent !== undefined
      ? { granted: knownConsent?.granted === true, version: knownConsent?.version ?? null, updatedAt: knownConsent?.updatedAt ?? null }
      : await getTrackingConsent(userId);
  if (!consent.granted) {
    return { tracking: "disabled", recorded: 0, duplicates: 0, rejected: 0 };
  }

  const now = Date.now();
  const prepared: PreparedEvent[] = events.map((e) => {
    const claimed = e.clientTs ? new Date(e.clientTs) : undefined;
    const sane = claimed && Math.abs(claimed.getTime() - now) <= MAX_CLIENT_CLOCK_SKEW_MS;
    return {
      userId,
      eventId: e.eventId,
      type: e.type,
      source: "client",
      sessionId: e.sessionId,
      productId: e.productId,
      categoryId: e.categoryId,
      query: e.query,
      quantity: e.quantity,
      promotionId: e.promotionId,
      correlationId,
      metadata: e.metadata,
      occurredAt: sane ? claimed : new Date(now),
      consentVersion: consent.version ?? TRACKING_CONSENT_VERSION,
    };
  });

  const result = await writeEvents(prepared, { requireKnownRefs: true });
  recordWriteStats(result);
  return { tracking: "enabled", recorded: result.written, duplicates: result.duplicates, rejected: result.rejected };
}

// The caller's OWN history only - the userId always comes from the session.
export async function getOwnHistory(userId: string, page: number, pageSize: number) {
  const filter = { userId: new Types.ObjectId(userId) };
  const [items, total] = await Promise.all([
    UserInteractionEvent.find(filter)
      .sort({ serverTs: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select("-userId -consentVersion -schemaVersion -expiresAt -correlationId")
      .lean(),
    UserInteractionEvent.countDocuments(filter),
  ]);
  return { items, total, page, pageSize };
}

// Also the hook a future account-deletion flow should call.
export async function deleteAllForUser(userId: string): Promise<number> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError("Invalid user", 400);
  purgeBufferedForUser(userId);
  const result = await UserInteractionEvent.deleteMany({ userId: new Types.ObjectId(userId) });
  return result.deletedCount;
}
