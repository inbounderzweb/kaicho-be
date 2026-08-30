import crypto from "crypto";
import Razorpay from "razorpay";
import { env } from "../../config/env";
import { AppError } from "../errors";

// Thin wrapper over the `razorpay` SDK so the rest of the codebase never
// imports it directly: the checkout/payment services depend on these four
// functions, which keeps the SDK mockable in tests and gives one place to
// swap gateways later.
//
// The client is built lazily (not at module load) because env credentials are
// legitimately empty in development and in the test suite — constructing it
// eagerly would blow up merely by importing anything downstream of this file.

let client: Razorpay | null = null;

function getClient(): Razorpay {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new AppError("Payment gateway is not configured", 503);
  }
  if (!client) {
    client = new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
  }
  return client;
}

export interface RazorpayOrderResult {
  id: string;
  amount: number;
  currency: string;
}

// `amountPaise` is integer minor units — callers convert from the
// rupee-denominated totals with Math.round(x * 100), the same integer-money
// rule computeDiscount() follows.
export async function createRazorpayOrder(
  amountPaise: number,
  receipt: string
): Promise<RazorpayOrderResult> {
  const order = await getClient().orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt,
  });
  return {
    id: String(order.id),
    amount: Number(order.amount),
    currency: String(order.currency),
  };
}

// Constant-time comparison of two hex digests. crypto.timingSafeEqual throws
// on length mismatch, so the length check has to come first — that leak is
// harmless (digest length is fixed and public) and is exactly how a
// truncated/garbage signature gets rejected.
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Razorpay Checkout.js handback signature: HMAC-SHA256("<orderId>|<paymentId>")
// keyed with the API secret. Fails closed when no secret is configured.
export function verifyPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string
): boolean {
  if (!env.razorpayKeySecret || !razorpaySignature) return false;
  const expected = crypto
    .createHmac("sha256", env.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, razorpaySignature);
}

// Webhook signature: HMAC-SHA256 over the EXACT raw request bytes (see
// app.ts's express.json({ verify }) callback) keyed with the webhook secret,
// which is a different secret from the API key secret.
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.razorpayWebhookSecret || !signature || !rawBody) return false;
  const expected = crypto
    .createHmac("sha256", env.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  return timingSafeEqualHex(expected, signature);
}

export interface RazorpayRefundResult {
  id: string;
  amount: number;
  status: string;
}

// Omitting `amount` refunds the full captured amount — that's Razorpay's own
// default for an empty payload, so there's no need to look the amount up.
export async function refundPayment(
  razorpayPaymentId: string,
  amountPaise?: number
): Promise<RazorpayRefundResult> {
  const refund = await getClient().payments.refund(
    razorpayPaymentId,
    amountPaise ? { amount: amountPaise } : {}
  );
  return {
    id: String(refund.id),
    amount: Number(refund.amount),
    status: String(refund.status),
  };
}
