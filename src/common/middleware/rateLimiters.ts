import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../../config/env";

const windowMs = env.rateLimitWindowMinutes * 60 * 1000;

export const otpIpLimiter = rateLimit({
  windowMs,
  max: env.rateLimitOtpMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this device. Please try again later.",
  },
});

export const otpPhoneLimiter = rateLimit({
  windowMs,
  max: env.rateLimitOtpMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const phone = typeof req.body?.phone === "string" ? req.body.phone : undefined;
    return phone ?? ipKeyGenerator(req.ip ?? "unknown");
  },
  message: {
    success: false,
    message: "Too many requests for this phone number. Please try again later.",
  },
});

export const mediaUploadLimiter = rateLimit({
  windowMs,
  max: env.rateLimitMediaUploadMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many upload requests. Please try again later.",
  },
});

export const mediaDeleteLimiter = rateLimit({
  windowMs,
  max: env.rateLimitMediaDeleteMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many delete requests. Please try again later.",
  },
});

// Keyed per logged-in user rather than per IP (same identity-based keying as
// otpPhoneLimiter) — checkout is always behind requireAuth, and a shared
// office/CGNAT IP must not let one customer's retries lock out everyone
// else's. Falls back to the IP only if it somehow runs unauthenticated.
export const checkoutLimiter = rateLimit({
  windowMs,
  max: env.rateLimitCheckoutMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: "Too many checkout attempts. Please try again later.",
  },
});

// Same per-user keying. Deliberately NOT applied to the Razorpay webhook
// route — that one is called by Razorpay's servers and its correctness comes
// from signature verification, not throttling.
export const paymentVerifyLimiter = rateLimit({
  windowMs,
  max: env.rateLimitCheckoutMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: "Too many payment verification attempts. Please try again later.",
  },
});
