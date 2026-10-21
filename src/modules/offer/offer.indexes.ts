import { Offer, OfferUsage, OfferActivity } from "../../database/models";

// Offers carry hard guarantees that live in indexes, not application code:
//   - offer_usages (offerId,orderId)            UNIQUE  one redemption per order
//   - offer_usages (offerId,userId,perUserSeq)  UNIQUE  race-safe per-user cap
// Explicit + awaited at boot, exactly like ensureCouponIndexes — autoIndex is
// commonly disabled in production. createIndexes() only ADDS missing indexes.
export async function ensureOfferIndexes(): Promise<void> {
  await Promise.all([Offer.createIndexes(), OfferUsage.createIndexes(), OfferActivity.createIndexes()]);
  console.log("[offer] indexes ensured (usage constraints)");
}
