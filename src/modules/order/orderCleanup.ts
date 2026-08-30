import { Order } from "../../database/models";
import { restoreStockForOrder } from "./order.service";

// Abandoned checkouts: a PENDING_PAYMENT order holds decremented stock from
// the moment it's created, so a customer who opens the Razorpay modal and
// then closes the tab would otherwise keep that stock hostage forever. Same
// shape as mediaCleanup.ts's expired-TEMPORARY-media sweep (find expired,
// undo per item, count successes/failures, never let one bad item abort the
// rest of the run).
//
// 30 minutes is comfortably longer than a Razorpay checkout session, so a
// customer mid-payment is never cancelled out from under themselves. If the
// payment does land after cleanup, the webhook's markOrderPaid deliberately
// refuses to drag a CANCELLED order back to CONFIRMED (see payment.service)
// and leaves it for an admin to refund.
export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000;

export async function cancelStalePendingOrders(): Promise<{ cancelled: number; failed: number }> {
  const cutoff = new Date(Date.now() - PENDING_ORDER_TTL_MS);
  const stale = await Order.find({
    status: "PENDING_PAYMENT",
    createdAt: { $lt: cutoff },
  }).exec();

  let cancelled = 0;
  let failed = 0;

  for (const doc of stale) {
    try {
      await restoreStockForOrder(doc);
      doc.status = "CANCELLED";
      doc.paymentStatus = "FAILED";
      doc.cancelReason = "Payment not completed in time";
      doc.statusHistory.push({
        status: "CANCELLED",
        at: new Date(),
        note: "Payment not completed in time",
      });
      await doc.save();
      cancelled += 1;
    } catch (err) {
      // Left for the next run rather than aborting the sweep — same
      // treatment mediaCleanup gives a file it couldn't delete.
      failed += 1;
      console.error("Stale order cleanup failed", {
        orderNumber: doc.orderNumber,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  if (cancelled > 0 || failed > 0) {
    console.log("Order cleanup:", { cancelled, failed });
  }

  return { cancelled, failed };
}
