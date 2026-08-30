import { AppError } from "../../common/errors";
import { Order, OrderDocument } from "../../database/models";
import { verifyPaymentSignature, verifyWebhookSignature } from "../../common/payments/razorpay";
import { restoreStockForOrder, toOrderDto } from "../order/order.service";
import type { VerifyPaymentInput } from "./payment.validation";

// Two independent paths can mark an order paid: the browser handback
// (verifyPayment, fast, but only runs if the customer's tab survives) and the
// webhook (slower, but Razorpay retries it until we 2xx). Both funnel through
// markOrderPaid, whose "already PAID → no-op" guard is what makes running
// both — in either order, any number of times — safe.

function markOrderPaid(doc: OrderDocument, razorpayPaymentId: string, razorpaySignature?: string): boolean {
  if (doc.paymentStatus === "PAID") return false;

  doc.paymentStatus = "PAID";
  doc.payment = {
    ...(doc.payment ?? {}),
    razorpayPaymentId,
    ...(razorpaySignature ? { razorpaySignature } : {}),
    paidAt: new Date(),
  };

  // A cancelled order that somehow gets paid is NOT dragged back to
  // CONFIRMED — its stock was already released, so confirming it would
  // promise inventory that may no longer exist. It's recorded as paid and
  // left for an admin to refund.
  if (doc.status === "PENDING_PAYMENT") {
    doc.status = "CONFIRMED";
    doc.statusHistory.push({ status: "CONFIRMED", at: new Date(), note: "Payment received" });
  }
  return true;
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
  if (doc.paymentStatus === "PAID") {
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

  markOrderPaid(doc, input.razorpayPaymentId, input.razorpaySignature);
  await doc.save();

  return { order: toOrderDto(doc), alreadyVerified: false };
}

// ---- Webhook ----

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
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
    const changed = markOrderPaid(doc, entity.id);
    if (changed) await doc.save();
    return { handled: true };
  }

  if (event === "payment.failed") {
    const entity = body.payload?.payment?.entity;
    const doc = await findOrderByRazorpayOrderId(entity?.order_id);
    if (!doc) return logUnmatched(event, entity?.order_id);
    // Only a still-pending payment can fail. An order already PAID (the
    // customer retried and the second attempt succeeded) must not be
    // downgraded by a late failure event for the first attempt.
    if (doc.paymentStatus === "PENDING") {
      doc.paymentStatus = "FAILED";
      if (doc.status === "PENDING_PAYMENT") {
        await restoreStockForOrder(doc);
        doc.status = "CANCELLED";
        doc.cancelReason = "Payment failed";
        doc.statusHistory.push({ status: "CANCELLED", at: new Date(), note: "Payment failed" });
      }
      await doc.save();
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
