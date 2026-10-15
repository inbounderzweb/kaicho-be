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

// The razorpay SDK rejects with a plain object ({ statusCode, error: { code,
// description } }), not an Error. errorHandler can't read a message off that,
// so every failure (bad/mis-set API keys, amount out of range, gateway down)
// surfaced to the client as an opaque 500 "Internal Server Error" with nothing
// in the logs. Convert it into an AppError carrying Razorpay's own reason.
function toGatewayError(err: unknown, action: string): AppError {
  if (err instanceof AppError) return err;
  const e = err as { statusCode?: number; error?: { code?: string; description?: string }; message?: string } | undefined;
  const description = e?.error?.description ?? e?.message ?? "unknown error";
  console.error(`[razorpay] ${action} failed`, { statusCode: e?.statusCode, code: e?.error?.code, description });
  // 401 = our credentials are wrong: a server-side config problem, not the customer's request.
  const status = e?.statusCode === 400 ? 400 : 502;
  const message =
    e?.statusCode === 401
      ? "Payment gateway authentication failed. Please contact support."
      : `Payment gateway error: ${description}`;
  return new AppError(message, status);
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
  let order;
  try {
    order = await getClient().orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
    });
  } catch (err) {
    throw toGatewayError(err, "orders.create");
  }
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
  let refund;
  try {
    refund = await getClient().payments.refund(razorpayPaymentId, amountPaise ? { amount: amountPaise } : {});
  } catch (err) {
    throw toGatewayError(err, "payments.refund");
  }
  return {
    id: String(refund.id),
    amount: Number(refund.amount),
    status: String(refund.status),
  };
}
