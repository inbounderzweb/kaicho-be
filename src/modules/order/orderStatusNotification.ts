import { env } from "../../config/env";
import { OrderDocument, OrderStatus, User } from "../../database/models";
import { sendEmail, maskEmail } from "../../common/email/email.service";
import { orderStatusEmail, type OrderEmailStatus } from "../../common/email/templates";

// Customer-visible milestones, including the first successful confirmation
// from COD checkout or a captured online payment. An unpaid checkout and a
// customer's own return request are not confirmation events.
export const NOTIFY_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "CONFIRMED",
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

export interface EmailOutcome {
  /** not_applicable: this change isn't one we email about. */
  state: "sent" | "skipped" | "failed" | "not_applicable";
  /** Human-readable reason, shown to the admin who made the change. */
  message?: string;
}

// How long an admin's status update may wait for the SMTP hand-off. The email
// is sent INSIDE the request (not after the response): on serverless hosting
// such as Cloud Run the CPU is throttled once the response has gone out, so a
// background "fire-and-forget" send can stall or never finish — the customer
// would simply never get the mail. Waiting a bounded few seconds is the
// reliable option; the budget keeps a slow provider from hanging the admin UI.
const EMAIL_BUDGET_MS = 8000;

// Call AFTER the status change is saved. Emails the customer for the
// FINAL status (a shipment update can advance an order several steps in one
// save - they get one message, not three). Does nothing if the status didn't
// change. NEVER throws: an email problem can't affect the admin's update — it
// is reported back as an outcome instead, so the admin can see whether the
// customer was actually told.
//
// Only a VERIFIED email address is used: accounts that signed up by phone may
// carry an unverified email, and we won't send order updates to it.
export async function notifyOrderStatusChange(doc: OrderDocument, previous: OrderStatus): Promise<EmailOutcome> {
  if (doc.status === previous || !NOTIFY_STATUSES.has(doc.status)) return { state: "not_applicable" };

  // One promise that always RESOLVES (never rejects): whichever of the send or
  // the time budget finishes first decides the outcome; the loser is ignored.
  return new Promise<EmailOutcome>((resolve) => {
    const failed = (reason: string): EmailOutcome => {
      console.error(`[order] status email failed for ${doc.orderNumber}: ${reason}`);
      return { state: "failed", message: `Email could not be sent (${reason}).` };
    };
    const timer = setTimeout(() => resolve(failed("the email provider took too long to respond")), EMAIL_BUDGET_MS);
    send(doc).then(
      (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
      (err) => {
        clearTimeout(timer);
        resolve(failed(err instanceof Error ? err.message : "unknown error"));
      }
    );
  });
}

async function send(doc: OrderDocument): Promise<EmailOutcome> {
  const user = await User.findById(doc.userId).select("email emailVerified firstName lastName").lean();
  if (!user?.email || user.emailVerified !== true) {
    const message = user?.email
      ? "The customer's email address isn't verified, so no email was sent."
      : "The customer has no email address on their account, so no email was sent.";
    console.info(`[order] status email skipped for ${doc.orderNumber}: ${message}`);
    return { state: "skipped", message };
  }

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
  return { state: "sent", message: `Customer notified at ${maskEmail(user.email)}.` };
}
