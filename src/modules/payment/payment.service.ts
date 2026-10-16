import { AppError } from "../../common/errors";
import { Order, OrderDocument, type OrderPaymentStatus } from "../../database/models";
import { fetchRazorpayOrderPayments, verifyPaymentSignature, verifyWebhookSignature } from "../../common/payments/razorpay";
import { paymentCutoff } from "../order/orderPaymentWindow";
import { toGa4PurchaseParams, toOrderDto } from "../order/order.service";
import { notifyAdminsNewOrder } from "../notification/notification.service";
import { notifyOrderStatusChange } from "../order/orderStatusNotification";
import { trackServerPurchase } from "../../common/analytics/ga4";
import { interactionTrackingService } from "../interaction/interaction.tracking.service";
import type { VerifyPaymentInput } from "./payment.validation";

// Two independent paths can mark an order paid: the browser handback
// (verifyPayment, fast, but only runs if the customer's tab survives) and the
// webhook (slower, but Razorpay retries it until we 2xx). Both funnel through
// markOrderPaid, whose atomic "already settled → no-op" guard makes running
// both — in either order, any number of times — safe.

const SETTLED_PAYMENT_STATUSES: OrderPaymentStatus[] = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"];

async function markOrderPaid(
  doc: OrderDocument,
  razorpayPaymentId: string,
  razorpaySignature?: string
): Promise<{ order: OrderDocument; changed: boolean; justConfirmed: boolean }> {
  if (SETTLED_PAYMENT_STATUSES.includes(doc.paymentStatus)) return { order: doc, changed: false, justConfirmed: false };

  const at = new Date();
  const paymentFields = {
    paymentStatus: "PAID" as const,
    "payment.razorpayPaymentId": razorpayPaymentId,
    ...(razorpaySignature ? { "payment.razorpaySignature": razorpaySignature } : {}),
    "payment.paidAt": at,
  };
  const unpaid = { _id: doc._id, paymentStatus: { $nin: SETTLED_PAYMENT_STATUSES } };

  // The browser and webhook can both load the same unpaid document. Claim
  // the transition in MongoDB so exactly one may append the confirmation
  // and trigger customer/admin delivery. A read-then-save guard races.
  const confirmed = await Order.findOneAndUpdate(
    { ...unpaid, status: "PENDING_PAYMENT" },
    {
      $set: { ...paymentFields, status: "CONFIRMED" },
      $push: { statusHistory: { status: "CONFIRMED", at, note: "Payment received" } },
    },
    { returnDocument: "after" }
  ).exec();
  if (confirmed) return { order: confirmed, changed: true, justConfirmed: true };

  // A cancelled order that gets paid keeps its cancellation: released
  // stock cannot be promised again. This also tolerates an admin advancing
  // the status after the original read, without overwriting their change.
  const paid = await Order.findOneAndUpdate(
    { ...unpaid, status: { $ne: "PENDING_PAYMENT" } },
    { $set: paymentFields },
    { returnDocument: "after" }
  ).exec();
  if (paid) return { order: paid, changed: true, justConfirmed: false };

  const current = await Order.findById(doc._id).exec();
  if (!current) throw new AppError("Order not found", 404);
  return { order: current, changed: false, justConfirmed: false };
}

// Fires the admin notification and the GA4 purchase event exactly once, at
// the moment an order first becomes CONFIRMED via payment (mirrors the COD
// branch in checkout.service.ts, which fires both at its own CONFIRMED
// moment instead). markOrderPaid's atomic "already settled -> no-op" guard means
// `justConfirmed` is only true on the first pending-to-confirmed transition, so
// neither call can double-fire for the same order across the verify +
// webhook paths racing each other.
function notifyIfJustConfirmed(doc: OrderDocument, justConfirmed: boolean): void {
  if (!justConfirmed || doc.status !== "CONFIRMED") return;
  notifyOrderStatusChange(doc, "PENDING_PAYMENT");
  notifyAdminsNewOrder(doc).catch((err) => {
    console.error("[notification] new-order notify failed", err);
  });
  trackServerPurchase(toGa4PurchaseParams(doc)).catch((err) => {
    console.error("[analytics] GA4 purchase tracking failed", err);
  });
  // Interaction history. Same exactly-once moment as the calls above; never
  // throws, and the recovery sweep repairs a miss.
  void interactionTrackingService.trackPurchaseForOrder(doc);
}

export async function verifyPayment(userId: string, input: VerifyPaymentInput) {
  const doc = await Order.findOne({ _id: input.orderId, userId }).exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }

  // The gateway order id must be the one WE created for this order —
  // otherwise a valid signature from some unrelated (e.g. ₹1 self-made)
  // Razorpay order could be replayed to settle an expensive one.
  if (!doc.payment?.razorpayOrderId || doc.payment.razorpayOrderId !== input.razorpayOrderId) {
    throw new AppError("Payment verification failed", 400);
  }

  // Idempotent: a double-submitted verify (or one racing the webhook) is a
  // success, not an error — and deliberately skips re-verification so a
  // second call can't flip an already-settled order into a failure.
  if (SETTLED_PAYMENT_STATUSES.includes(doc.paymentStatus)) {
    return { order: toOrderDto(doc), alreadyVerified: true };
  }

  const valid = verifyPaymentSignature(
    input.razorpayOrderId,
    input.razorpayPaymentId,
    input.razorpaySignature
  );
  if (!valid) {
    throw new AppError("Payment verification failed", 400);
  }

  const { order, changed, justConfirmed } = await markOrderPaid(doc, input.razorpayPaymentId, input.razorpaySignature);
  notifyIfJustConfirmed(order, justConfirmed);

  return { order: toOrderDto(order), alreadyVerified: !changed };
}

// ---- Retry payment on an existing pending order ----

export interface PaymentRetryResult {
  order: ReturnType<typeof toOrderDto>;
  /** What Checkout.js needs to open the modal; null when the order turned out to be paid already. */
  razorpayOrder: { id: string; amount: number; currency: string } | null;
  alreadyPaid: boolean;
}

// Lets a customer pay again for an order they abandoned or whose payment
// failed, instead of being forced to cancel and rebuild the cart.
//
// The SAME Razorpay order is reused (never a new one): a Razorpay order accepts
// many attempts until one succeeds and then refuses further payments, which is
// exactly the double-charge protection we want — a second order id would let
// the customer pay twice for one order. Stock is already reserved by the
// pending order, so nothing is re-reserved here.
//
// Everything is re-checked server-side; the UI's "Pay now" is only a hint.
export async function startPaymentRetry(userId: string, orderNumber: string): Promise<PaymentRetryResult> {
  const doc = await Order.findOne({ userId, orderNumber }).exec();
  if (!doc) throw new AppError("Order not found", 404);

  if (doc.paymentMethod !== "RAZORPAY") {
    throw new AppError("This order isn't an online-payment order", 409);
  }
  if (SETTLED_PAYMENT_STATUSES.includes(doc.paymentStatus)) {
    return { order: toOrderDto(doc), razorpayOrder: null, alreadyPaid: true };
  }
  if (doc.status !== "PENDING_PAYMENT" || doc.paymentStatus !== "PENDING" || !doc.payment?.razorpayOrderId) {
    throw new AppError("This order can no longer be paid. Please place a new order.", 409);
  }
  if (paymentCutoff(doc.createdAt).getTime() <= Date.now()) {
    throw new AppError("The payment window for this order has closed. Please place a new order.", 409);
  }

  // Reconcile before charging again: if the gateway already captured a payment
  // for this order (handback + webhook both missed), settle it now. Otherwise
  // the customer could be sent to pay for something they've already paid for.
  const payments = await fetchRazorpayOrderPayments(doc.payment.razorpayOrderId);
  const captured = payments.find((p) => p.status === "captured");
  if (captured) {
    const { order, justConfirmed } = await markOrderPaid(doc, captured.id);
    notifyIfJustConfirmed(order, justConfirmed);
    return { order: toOrderDto(order), razorpayOrder: null, alreadyPaid: true };
  }

  return {
    order: toOrderDto(doc),
    razorpayOrder: {
      id: doc.payment.razorpayOrderId,
      amount: Math.round(doc.pricing.grandTotal * 100),
      currency: "INR",
    },
    alreadyPaid: false,
  };
}

// ---- Webhook ----

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; error_description?: string } };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
  };
}

export function assertValidWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): void {
  if (!rawBody || !signature) {
    throw new AppError("Invalid webhook signature", 400);
  }
  if (!verifyWebhookSignature(rawBody, signature)) {
    throw new AppError("Invalid webhook signature", 400);
  }
}

// Never throws for an unknown/unmatched event. Razorpay retries anything that
// isn't a 2xx, so 404-ing on an event for an order we don't have (test
// webhooks, events from another integration on the same account) would just
// generate retries forever. Unhandled events are logged and acknowledged.
export async function handleWebhookEvent(body: RazorpayWebhookPayload): Promise<{ handled: boolean }> {
  const event = body.event;

  if (event === "payment.captured") {
    const entity = body.payload?.payment?.entity;
    const doc = await findOrderByRazorpayOrderId(entity?.order_id);
    if (!doc || !entity?.id) return logUnmatched(event, entity?.order_id);
    const { order, justConfirmed } = await markOrderPaid(doc, entity.id);
    notifyIfJustConfirmed(order, justConfirmed);
    return { handled: true };
  }

  if (event === "payment.failed") {
    const entity = body.payload?.payment?.entity;
    const doc = await findOrderByRazorpayOrderId(entity?.order_id);
    if (!doc) return logUnmatched(event, entity?.order_id);
    // A failed ATTEMPT is not a failed ORDER. Razorpay fires this for every
    // declined card / wrong OTP, and the customer can retry inside the same
    // modal or from the order page. Cancelling here would kill the order
    // mid-retry (and a later successful capture could then only be refunded).
    // So just record why it failed; the order keeps its reserved stock until
    // it's paid, the customer cancels, or the cleanup sweep expires it
    // (orderCleanup.ts) — the one place abandoned stock is released.
    // Guarded on current state so a captured payment that overtook this event
    // is never touched.
    if (doc.paymentStatus === "PENDING") {
      await Order.updateOne(
        { _id: doc._id, paymentStatus: "PENDING" },
        {
          $set: {
            "payment.lastFailureReason": (entity?.error_description ?? "Payment failed").slice(0, 300),
            "payment.lastFailedAt": new Date(),
          },
        }
      );
    }
    return { handled: true };
  }

  if (event === "refund.processed") {
    const entity = body.payload?.refund?.entity;
    const doc = entity?.payment_id
      ? await Order.findOne({ "payment.razorpayPaymentId": entity.payment_id }).exec()
      : null;
    if (!doc) return logUnmatched(event, entity?.payment_id);
    if (doc.paymentStatus !== "REFUNDED") {
      // Razorpay reports refund amounts in paise; our records are in rupees.
      const refundedRupees = entity?.amount ? entity.amount / 100 : doc.pricing.grandTotal;
      const totalMinor = Math.max(
        Math.round((doc.payment?.refundedAmount ?? 0) * 100),
        Math.round(refundedRupees * 100)
      );
      doc.payment = { ...(doc.payment ?? {}), refundedAmount: totalMinor / 100 };
      doc.paymentStatus =
        totalMinor >= Math.round(doc.pricing.grandTotal * 100) ? "REFUNDED" : "PARTIALLY_REFUNDED";
      await doc.save();
    }
    return { handled: true };
  }

  console.warn("Unhandled Razorpay webhook event", { event });
  return { handled: false };
}

async function findOrderByRazorpayOrderId(razorpayOrderId: string | undefined) {
  if (!razorpayOrderId) return null;
  return Order.findOne({ "payment.razorpayOrderId": razorpayOrderId }).exec();
}

function logUnmatched(event: string | undefined, reference: string | undefined): { handled: boolean } {
  console.warn("Razorpay webhook referenced an unknown order", { event, reference });
  return { handled: false };
}

export type { RazorpayWebhookPayload };
