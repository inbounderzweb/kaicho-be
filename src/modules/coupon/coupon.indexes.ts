import { Coupon, CouponUsage, CouponActivity } from "../../database/models";

// Coupons carry hard guarantees that live in indexes, not application code:
//   - coupons.code                     UNIQUE  (spec §4 — a DB-level constraint,
//                                               not just a validation check)
//   - coupon_usages (couponId,orderId) UNIQUE  (a coupon consumed once per order)
//   - coupon_usages (couponId,userId,perUserSeq) UNIQUE (race-safe per-user cap)
//
// Mongoose's autoIndex builds these in the background on first use and is
// commonly disabled in production, so — exactly like ensureUserAuthIndexes —
// this makes the build explicit and awaited at boot. createIndexes() only
// ADDS what the schema declares and the collection lacks; it never drops.
export async function ensureCouponIndexes(): Promise<void> {
  await Promise.all([
    Coupon.createIndexes(),
    CouponUsage.createIndexes(),
    CouponActivity.createIndexes(),
  ]);
  console.log("[coupon] indexes ensured (code unique, usage constraints)");
}
