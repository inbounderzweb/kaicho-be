// How long an unpaid (PENDING_PAYMENT) order keeps its stock reserved before
// the cleanup sweep cancels it. Comfortably longer than a Razorpay checkout
// session, so a customer mid-payment is never cancelled out from under
// themselves. Lives in its own file so order.service (DTO) and orderCleanup
// (sweep) share one value without importing each other.
export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000;

// A customer may retry payment on a still-pending order only while at least
// this much of the window is left. Without a margin, a payment started in the
// last seconds could land just after the sweep cancelled the order — money
// taken for an order that no longer exists (it would then need a manual
// refund). Better to ask them to place a fresh order.
export const PAYMENT_RETRY_MIN_REMAINING_MS = 3 * 60 * 1000;

/** Last moment a customer may START a payment on an order created at `createdAt`. */
export function paymentCutoff(createdAt: Date): Date {
  return new Date(createdAt.getTime() + PENDING_ORDER_TTL_MS - PAYMENT_RETRY_MIN_REMAINING_MS);
}
