import { env } from "../../config/env";
import { OrderDocument, OrderStatus, User } from "../../database/models";
import { sendEmail, maskEmail } from "../../common/email/email.service";
import { orderStatusEmail, type OrderEmailStatus } from "../../common/email/templates";

// Statuses the customer is told about when an ADMIN moves their order there.
// Deliberately not here: PENDING_PAYMENT / CONFIRMED (checkout's own flow),
// and RETURN_REQUESTED (the customer's own action).
export const NOTIFY_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "RETURNED",
  "REFUNDED",
]);

const SAFE_URL = /^https?:\/\//i;

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

// Call AFTER the status change is saved. Emails the customer once, for the
// FINAL status (a shipment update can advance an order several steps in one
// save - they get one message, not three). Does nothing if the status didn't
// change. Fire-and-forget: never awaited, never throws, and an email problem
// can't affect the admin's update.
//
// Only a VERIFIED email address is used: accounts that signed up by phone may
// carry an unverified email, and we won't send order updates to it.
export function notifyOrderStatusChange(doc: OrderDocument, previous: OrderStatus): void {
  if (doc.status === previous || !NOTIFY_STATUSES.has(doc.status)) return;
  void send(doc).catch((err) => {
    console.error(
      `[order] status email failed for ${doc.orderNumber}:`,
      err instanceof Error ? err.message : "unknown error"
    );
  });
}

async function send(doc: OrderDocument): Promise<void> {
  const user = await User.findById(doc.userId).select("email emailVerified firstName lastName").lean();
  if (!user?.email || user.emailVerified !== true) return;

  const base = env.appUrl ?? env.frontendOrigins[0];
  const shipment = doc.shipment;
  const showTracking = doc.status === "SHIPPED" || doc.status === "OUT_FOR_DELIVERY";
  const { subject, html, text } = orderStatusEmail({
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "there",
    orderNumber: doc.orderNumber,
    status: doc.status as OrderEmailStatus,
    orderLink: `${base}/orders/${encodeURIComponent(doc.orderNumber)}`,
    ...(showTracking && shipment
      ? {
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl && SAFE_URL.test(shipment.trackingUrl) ? shipment.trackingUrl : undefined,
          estimatedDelivery: shipment.estimatedDeliveryAt ? formatDate(shipment.estimatedDeliveryAt) : undefined,
        }
      : {}),
  });
  console.info(`[order] status email ${doc.status} -> ${maskEmail(user.email)} (${doc.orderNumber})`);
  await sendEmail({ to: user.email, subject, html, text });
}
