import { z } from "zod";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// The three values Razorpay Checkout.js hands back to the browser, plus our
// own order id so the server doesn't have to trust the gateway ids alone to
// find the order. All are opaque strings; only bounds are enforced here —
// the real validation is the HMAC check in the service.
export const verifyPaymentSchema = z.object({
  orderId: objectIdField,
  razorpayOrderId: z.string().trim().min(1, "razorpayOrderId is required").max(200),
  razorpayPaymentId: z.string().trim().min(1, "razorpayPaymentId is required").max(200),
  razorpaySignature: z.string().trim().min(1, "razorpaySignature is required").max(500),
});

export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;
