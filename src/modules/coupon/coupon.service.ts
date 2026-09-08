import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Coupon,
  CouponDocument,
  CouponDiscountType,
  CouponUsage,
} from "../../database/models";

// The coupon domain layer. Deliberately imports only models + AppError — it
// is imported BY checkout.service / order.service / payment.service, so it
// must not import any of them back (no cycles).
//
// No MongoDB transactions are available on this deployment (standalone
// mongod), so consume/release use the same tools the checkout stock
// reservation does: atomic conditional updates, unique-index collisions, and
// compensating writes.

// A single opaque message for "this code doesn't resolve to a usable
// coupon" — not-found, DRAFT, PAUSED and ARCHIVED all return it, so the
// endpoint can't be used to enumerate which codes exist or what state
// they're in. Expiry / not-started / minimum-order are safe (and useful) to
// state plainly.
const GENERIC_INVALID = "This coupon code isn't valid.";

export type EffectiveCouponStatus =
  | "DRAFT"
  | "ACTIVE"
  | "PAUSED"
  | "ARCHIVED"
  | "EXPIRED"
  | "SCHEDULED";

export interface CouponDiscountBreakdown {
  discountType: CouponDiscountType;
  /** Rupees taken off the subtotal. Always 0 for FREE_DELIVERY. */
  discountAmount: number;
  freeDelivery: boolean;
}

export interface EvaluatedCoupon extends CouponDiscountBreakdown {
  couponId: string;
  code: string;
  name: string;
}

/** "kaicho10" / " Kaicho10 " / "KAICHO 10" → "KAICHO10". The one canonical
 *  form both the unique index and every lookup agree on. */
export function canonicalizeCouponCode(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

type CouponLike = Pick<
  CouponDocument,
  "status" | "startsAt" | "expiresAt"
>;

/** Stored status folded together with the current time window. An ACTIVE
 *  coupon past its expiry is EXPIRED here regardless of what the column says
 *  — spec §17. */
export function getEffectiveCouponStatus(
  coupon: CouponLike,
  now: Date = new Date()
): EffectiveCouponStatus {
  if (coupon.status !== "ACTIVE") return coupon.status;
  if (coupon.startsAt && coupon.startsAt.getTime() > now.getTime()) return "SCHEDULED";
  if (coupon.expiresAt && coupon.expiresAt.getTime() < now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

type DiscountRule = Pick<
  CouponDocument,
  "discountType" | "discountValue" | "maxDiscountAmount"
>;

/** The one place (coupon rule, eligible subtotal) → rupees-off is computed.
 *  All maths in integer paise, same rule as computeOrderTotals / computeDiscount. */
export function computeCouponDiscount(
  coupon: DiscountRule,
  subtotal: number
): CouponDiscountBreakdown {
  if (coupon.discountType === "FREE_DELIVERY") {
    return { discountType: "FREE_DELIVERY", discountAmount: 0, freeDelivery: true };
  }

  const subtotalMinor = Math.round(subtotal * 100);
  let discountMinor: number;

  if (coupon.discountType === "PERCENTAGE") {
    discountMinor = Math.round((subtotalMinor * coupon.discountValue) / 100);
    if (coupon.maxDiscountAmount != null) {
      discountMinor = Math.min(discountMinor, Math.round(coupon.maxDiscountAmount * 100));
    }
  } else {
    // FIXED
    discountMinor = Math.round(coupon.discountValue * 100);
  }

  // Never below 0, never more than the order is worth.
  discountMinor = Math.max(0, Math.min(discountMinor, subtotalMinor));
  return { discountType: coupon.discountType, discountAmount: discountMinor / 100, freeDelivery: false };
}

/**
 * Runs every eligibility rule against a given eligible subtotal and returns
 * the discount the coupon WOULD grant. Does NOT consume anything and does NOT
 * mutate usedCount (spec §9). Throws AppError with a customer-safe message on
 * any failure.
 *
 * The global/per-user limit checks here are advisory (a plain count, subject
 * to a race) — the authoritative, race-safe enforcement is in
 * consumeCouponForOrder(). This check exists so preview / the validate
 * endpoint / the pre-flight in createCheckout can reject an obviously
 * exhausted coupon early with a clear message.
 */
export async function evaluateCouponForSubtotal(params: {
  code: string;
  userId: string;
  subtotal: number;
  now?: Date;
}): Promise<EvaluatedCoupon> {
  const code = canonicalizeCouponCode(params.code);
  if (!code) throw new AppError("Enter a coupon code.", 400);

  const coupon = await Coupon.findOne({ code }).lean();
  if (!coupon) throw new AppError(GENERIC_INVALID, 400);

  const now = params.now ?? new Date();
  const effective = getEffectiveCouponStatus(coupon, now);
  if (effective === "EXPIRED") throw new AppError("This coupon has expired.", 400);
  if (effective === "SCHEDULED") throw new AppError("This coupon isn't active yet.", 400);
  if (effective !== "ACTIVE") throw new AppError(GENERIC_INVALID, 400);

  if (params.subtotal <= 0) {
    throw new AppError("Add items to your cart before applying a coupon.", 400);
  }

  if (coupon.minOrderValue > 0 && params.subtotal < coupon.minOrderValue) {
    const shortfall = (coupon.minOrderValue - params.subtotal).toFixed(2);
    throw new AppError(
      `Add items worth ₹${shortfall} more to use this coupon (minimum order ₹${coupon.minOrderValue}).`,
      400
    );
  }

  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    throw new AppError("This coupon has reached its usage limit.", 400);
  }

  if (coupon.usageLimitPerUser != null) {
    const used = await CouponUsage.countDocuments({
      couponId: coupon._id,
      userId: new mongoose.Types.ObjectId(params.userId),
    });
    if (used >= coupon.usageLimitPerUser) {
      throw new AppError("You've already used this coupon.", 400);
    }
  }

  const breakdown = computeCouponDiscount(coupon, params.subtotal);
  return {
    couponId: coupon._id.toString(),
    code: coupon.code,
    name: coupon.name,
    ...breakdown,
  };
}

// ---- Consumption (race-safe, no transactions) ----

function isDuplicateKeyError(err: unknown, field: string): boolean {
  const candidate = err as { code?: number; keyPattern?: Record<string, unknown> };
  return candidate?.code === 11000 && Boolean(candidate.keyPattern && field in candidate.keyPattern);
}

const PER_USER_SEQ_ATTEMPTS = 5;

/**
 * Consumes one unit of the coupon FOR a specific, already-created order.
 * Called from createCheckout after the order row exists. Ordering matters:
 *
 *   1. Insert the CouponUsage row first. Its unique (couponId, userId,
 *      perUserSeq) index is what serialises concurrent redemptions by the
 *      same user; its unique (couponId, orderId) index makes a retry for the
 *      same order a no-op.
 *   2. Only then bump the global counter, atomically and guarded by the
 *      usage limit. If that guard fails (limit hit), delete the row we just
 *      inserted and throw.
 *
 * Throws AppError(409) on any "no longer available" outcome; the caller then
 * deletes the order and releases stock.
 */
export async function consumeCouponForOrder(params: {
  code: string;
  userId: string;
  order: { _id: mongoose.Types.ObjectId | string; orderNumber: string };
  discount: CouponDiscountBreakdown;
}): Promise<void> {
  const code = canonicalizeCouponCode(params.code);
  const coupon = await Coupon.findOne({ code }).lean();
  if (!coupon) throw new AppError("This coupon is no longer available.", 409);

  // Re-assert status/time window — this runs at a later instant than the
  // caller's pre-flight evaluateCouponForSubtotal (spec §10).
  if (getEffectiveCouponStatus(coupon) !== "ACTIVE") {
    throw new AppError("This coupon is no longer available.", 409);
  }

  const userId = new mongoose.Types.ObjectId(params.userId);
  const orderId =
    typeof params.order._id === "string"
      ? new mongoose.Types.ObjectId(params.order._id)
      : params.order._id;

  let created = false;
  for (let attempt = 0; attempt < PER_USER_SEQ_ATTEMPTS && !created; attempt++) {
    const usedByUser = await CouponUsage.countDocuments({ couponId: coupon._id, userId });
    const seq = usedByUser + 1;
    if (coupon.usageLimitPerUser != null && seq > coupon.usageLimitPerUser) {
      throw new AppError("You've already used this coupon.", 409);
    }

    try {
      await CouponUsage.create({
        couponId: coupon._id,
        couponCode: coupon.code,
        userId,
        orderId,
        orderNumber: params.order.orderNumber,
        discountType: params.discount.discountType,
        discountAmount: params.discount.discountAmount,
        freeDelivery: params.discount.freeDelivery,
        perUserSeq: seq,
        usedAt: new Date(),
      });
      created = true;
    } catch (err) {
      // Already consumed for this exact order (idempotent retry / the
      // browser-verify + webhook double path) — nothing more to do, and the
      // global counter was already bumped by the original call.
      if (isDuplicateKeyError(err, "orderId")) return;
      // Lost the seq race to another concurrent redemption by the same user —
      // recompute and try the next slot.
      if (isDuplicateKeyError(err, "perUserSeq")) continue;
      throw err;
    }
  }

  if (!created) {
    // Exhausted the retry budget fighting for a per-user seq slot.
    throw new AppError("This coupon is no longer available.", 409);
  }

  // The usage row now exists. Claim a global slot atomically. `$expr` lets
  // the filter compare usedCount against usageLimit within the document; a
  // null usageLimit means unlimited.
  const incremented = await Coupon.findOneAndUpdate(
    {
      _id: coupon._id,
      status: "ACTIVE",
      $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
    },
    { $inc: { usedCount: 1 } }
  ).exec();

  if (!incremented) {
    // Global limit hit between our row insert and now. Undo the row.
    await CouponUsage.deleteOne({ couponId: coupon._id, orderId }).catch(() => undefined);
    throw new AppError("This coupon is no longer available.", 409);
  }
}

/**
 * Full reversal of a consumed coupon when its order is cancelled/abandoned.
 * Deletes the usage row and decrements usedCount. Never throws — an order's
 * cancellation must not be blocked by a counter (same contract as
 * restoreStockForOrder). NOT called on refund: a refunded order was
 * fulfilled, so the redemption stands.
 */
export async function releaseCouponForOrder(order: {
  _id: mongoose.Types.ObjectId | string;
  orderNumber?: string;
  coupon?: { couponId: mongoose.Types.ObjectId | string } | null;
}): Promise<void> {
  if (!order.coupon?.couponId) return;
  const orderId =
    typeof order._id === "string" ? new mongoose.Types.ObjectId(order._id) : order._id;
  try {
    const removed = await CouponUsage.findOneAndDelete({ orderId }).exec();
    if (removed) {
      await Coupon.updateOne(
        { _id: removed.couponId, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1 } }
      ).exec();
    }
  } catch (err) {
    console.error("Coupon release failed", {
      orderNumber: order.orderNumber,
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}
