import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { verifyPayment, assertValidWebhookSignature, handleWebhookEvent } from "./payment.service";
import type { VerifyPaymentInput } from "./payment.validation";

// Razorpay signs the exact raw bytes of the webhook body, so the untouched
// buffer has to survive JSON parsing. app.ts's express.json({ verify }) hook
// stashes it here; this augmentation is what makes it typed rather than an
// `as any` cast at the read site — same pattern requireAuth.ts uses for
// `userId`.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const verifyPaymentHandler = asyncHandler(async (req: Request, res: Response) => {
  const { order, alreadyVerified } = await verifyPayment(req.userId!, req.body as VerifyPaymentInput);
  res.status(200).json({
    success: true,
    message: alreadyVerified ? "Payment already verified" : "Payment verified",
    data: { order },
  });
});

export const razorpayWebhookHandler = asyncHandler(async (req: Request, res: Response) => {
  // An invalid signature is the one case that must NOT be a 200 — it's the
  // only thing standing between this public route and anyone marking orders
  // paid, and a rejected forgery isn't something Razorpay will retry.
  assertValidWebhookSignature(req.rawBody, req.get("x-razorpay-signature"));

  // handleWebhookEvent never throws for an event type we don't handle or an
  // order we can't find — those are logged and acknowledged with a 200, so
  // Razorpay stops retrying something that can never succeed. It CAN throw on
  // a genuine infrastructure failure (DB down mid-write), and that one is
  // deliberately left to propagate: a 500 is exactly the case where we
  // *want* Razorpay's retry to deliver the event again.
  const { handled } = await handleWebhookEvent(req.body);

  res.status(200).json({ success: true, data: { received: true, handled } });
});
