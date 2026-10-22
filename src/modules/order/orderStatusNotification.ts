import { env } from "../../config/env";
import { Order, OrderDocument, OrderStatus, User } from "../../database/models";
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
  /**
   * not_applicable: this change isn't one we email about.
   * not_requested: the admin chose to save without emailing the customer.
   */
  state: "sent" | "skipped" | "failed" | "not_applicable" | "not_requested";
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
//
// `previous` null = "send for the current status regardless" (admin retry).
export async function notifyOrderStatusChange(doc: OrderDocument, previous: OrderStatus | null): Promise<EmailOutcome> {
  if ((previous !== null && doc.status === previous) || !NOTIFY_STATUSES.has(doc.status)) return { state: "not_applicable" };

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

// ---------------------------------------------------------------------------
// Admin-controlled sending. An admin's status/shipment update only emails the
// customer when the request EXPLICITLY asks for it (`sendEmail === true`, see
// order.validation.ts); the default is silence. Each (status, transition) can
// be emailed once: the send is claimed atomically before the SMTP hand-off, so
// a double-click, a concurrent duplicate request or a retry never sends twice.
// A failed or skipped send releases its claim so the admin can retry.
// ---------------------------------------------------------------------------

// A claim older than this with no `sentAt` belongs to a crashed request and can
// be taken over; it comfortably exceeds the 8s send budget.
const CLAIM_TTL_MS = 2 * 60 * 1000;

// Where the order's current status begins in its history: the key that makes
// "email for this transition" unique. Two racing requests for one change each
// append their own history entry, but both start the run at the same index.
function currentTransitionIndex(doc: OrderDocument): number {
  let i = doc.statusHistory.length - 1;
  while (i >= 0 && doc.statusHistory[i].status !== doc.status) i--;
  if (i < 0) return 0;
  while (i > 0 && doc.statusHistory[i - 1].status === doc.status) i--;
  return i;
}

async function claimStatusEmail(doc: OrderDocument): Promise<boolean> {
  const status = doc.status;
  const transitionIndex = currentTransitionIndex(doc);
  const now = new Date();
  // Free a dead claim (crashed mid-send) for this transition first.
  await Order.updateOne(
    { _id: doc._id },
    { $pull: { statusEmails: { status, transitionIndex, sentAt: { $exists: false }, claimedAt: { $lt: new Date(now.getTime() - CLAIM_TTL_MS) } } } }
  );
  const result = await Order.updateOne(
    { _id: doc._id, statusEmails: { $not: { $elemMatch: { status, transitionIndex } } } },
    { $push: { statusEmails: { status, transitionIndex, claimedAt: now } } }
  );
  return result.modifiedCount === 1;
}

async function settleStatusEmailClaim(doc: OrderDocument, sent: boolean): Promise<void> {
  const status = doc.status;
  const transitionIndex = currentTransitionIndex(doc);
  try {
    if (sent) {
      await Order.updateOne(
        { _id: doc._id, statusEmails: { $elemMatch: { status, transitionIndex } } },
        { $set: { "statusEmails.$.sentAt": new Date() } }
      );
    } else {
      await Order.updateOne({ _id: doc._id }, { $pull: { statusEmails: { status, transitionIndex, sentAt: { $exists: false } } } });
    }
  } catch (err) {
    console.error(`[order] could not settle status-email claim for ${doc.orderNumber}:`, err instanceof Error ? err.message : "unknown error");
  }
}

async function sendClaimed(doc: OrderDocument, previous: OrderStatus | null): Promise<EmailOutcome> {
  if ((previous !== null && doc.status === previous) || !NOTIFY_STATUSES.has(doc.status)) return { state: "not_applicable" };
  if (!(await claimStatusEmail(doc))) {
    return { state: "skipped", message: "The customer was already emailed about this update, so it wasn't sent again." };
  }
  const outcome = await notifyOrderStatusChange(doc, previous);
  await settleStatusEmailClaim(doc, outcome.state === "sent");
  return outcome;
}

/**
 * Call AFTER the change is saved. Emails only when the admin asked for it.
 * Like notifyOrderStatusChange it never throws.
 */
export async function notifyOrderStatusIfRequested(
  doc: OrderDocument,
  previous: OrderStatus,
  sendEmail: boolean
): Promise<EmailOutcome> {
  if (!sendEmail) {
    if (doc.status === previous || !NOTIFY_STATUSES.has(doc.status)) return { state: "not_applicable" };
    return { state: "not_requested", message: "Saved without emailing the customer." };
  }
  try {
    return await sendClaimed(doc, previous);
  } catch (err) {
    console.error(`[order] status email failed for ${doc.orderNumber}:`, err instanceof Error ? err.message : "unknown error");
    return { state: "failed", message: "Email could not be sent (unexpected error)." };
  }
}

/** Admin retry after a failed send: emails for the order's CURRENT status, once. */
export async function resendOrderStatusEmail(doc: OrderDocument): Promise<EmailOutcome> {
  try {
    return await sendClaimed(doc, null);
  } catch (err) {
    console.error(`[order] status email retry failed for ${doc.orderNumber}:`, err instanceof Error ? err.message : "unknown error");
    return { state: "failed", message: "Email could not be sent (unexpected error)." };
  }
}
