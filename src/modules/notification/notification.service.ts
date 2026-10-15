import { OrderDocument, User } from "../../database/models";
import { emitNewOrderNotification } from "./socket";
import { sendNewOrderEmail } from "./email";

// Single entry point for "an order just became real" — called from exactly
// the two places an order first reaches CONFIRMED (COD at checkout time,
// online payment at verify/webhook time; see checkout.service.ts and
// payment.service.ts). Never throws: a notification failing must never take
// down the order flow that triggered it, so every caller fires this without
// awaiting the result (only logging on rejection).
export async function notifyAdminsNewOrder(doc: OrderDocument): Promise<void> {
  let customerName = "Customer";
  try {
    const user = await User.findById(doc.userId).select("firstName lastName phone").lean();
    if (user) {
      customerName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.phone || "Customer";
    }
  } catch {
    // Best-effort label only — an unresolved customer name must not block
    // the notification itself.
  }

  const payload = {
    orderId: doc._id.toString(),
    orderNumber: doc.orderNumber,
    customerName,
    amount: doc.pricing.grandTotal,
    itemsCount: doc.items.length,
    createdAt: doc.createdAt.toISOString(),
    confirmedAt: (doc.statusHistory.find((entry) => entry.status === "CONFIRMED")?.at ?? doc.createdAt).toISOString(),
  };

  try {
    emitNewOrderNotification(payload);
  } catch (err) {
    console.error(`[notification] Failed to emit new-order alert for ${doc.orderNumber}:`, err instanceof Error ? err.message : "unknown error");
  }
  await sendNewOrderEmail({
    orderNumber: payload.orderNumber,
    customerName,
    amount: payload.amount,
    itemsCount: payload.itemsCount,
  });
}
