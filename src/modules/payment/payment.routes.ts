import { Router } from "express";
import { requireAuth, validateBody, paymentVerifyLimiter } from "../../common/middleware";
import { verifyPaymentSchema } from "./payment.validation";
import { verifyPaymentHandler, razorpayWebhookHandler } from "./payment.controller";

const router = Router();

// Customer handback from Razorpay Checkout.js — behind the session cookie,
// and the service additionally scopes the order lookup to req.userId.
router.post(
  "/razorpay/verify",
  requireAuth,
  paymentVerifyLimiter,
  validateBody(verifyPaymentSchema),
  verifyPaymentHandler
);

// Called by Razorpay's servers, which have no session cookie — authenticity
// comes from the HMAC over the raw body (x-razorpay-signature), verified
// first thing in the handler. Deliberately NOT rate-limited: throttling the
// gateway would drop legitimate payment events, and a forged request is
// already rejected by the signature check.
router.post("/razorpay/webhook", razorpayWebhookHandler);

export default router;
