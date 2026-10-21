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

// Public lead-capture forms (contact, bulk order). Per-IP — an anonymous
// visitor has no identity to key on — and deliberately generous so a genuine
// user correcting a typo and resubmitting isn't blocked, while a script
// hammering the endpoint is.
export const inquirySubmitLimiter = rateLimit({
  windowMs,
  max: env.rateLimitInquiryMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many submissions from this device. Please try again later.",
  },
});

// Public location proxy (/api/location/*). Per-IP — an anonymous visitor has
// no identity to key on — and generous, since detect + a few search
// keystrokes + a serviceability check all count. Its real job is to stop a
// script from turning our Nominatim proxy into an open relay.
export const locationLimiter = rateLimit({
  windowMs,
  max: env.rateLimitLocationMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many location requests from this device. Please try again shortly.",
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

// Interaction-event ingestion. Per logged-in user (the route is behind
// requireAuth), so a shared NAT'd IP doesn't throttle other customers.
export const interactionLimiter = rateLimit({
  windowMs,
  max: env.rateLimitInteractionMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

// Coupon-code validation. Same per-user keying as checkout (it's always
// behind requireAuth). Its real job is to stop a script enumerating valid
// codes through /api/coupons/validate — the endpoint already returns a
// single opaque message for every "not usable" reason, and this caps the
// attempt rate on top.
export const couponValidateLimiter = rateLimit({
  windowMs,
  max: env.rateLimitCouponValidateMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: "Too many coupon attempts. Please try again later.",
  },
});

// Public cart-offer evaluation (POST /api/offers/evaluate). The cart page calls
// it on load and on every cart edit, for guests too, so it is per-IP and
// sized like event ingestion rather than like an attack surface.
export const offerEvaluateLimiter = rateLimit({
  windowMs,
  max: env.rateLimitInteractionMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
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

// --- Email/password auth -----------------------------------------------------
// The per-email limiters are the real brute-force/abuse controls (an IP is
// cheap to rotate; the target address is not). The per-IP ones are a coarse
// backstop. All are in-memory per process, like the limiters above - with
// WEB_CONCURRENCY > 1 the effective ceiling is multiplied by the worker count.

function emailKey(req: { body?: { email?: unknown }; ip?: string }): string {
  const email = typeof req.body?.email === "string" ? req.body.email : undefined;
  return email ? `email:${email}` : ipKeyGenerator(req.ip ?? "unknown");
}

export const registerIpLimiter = rateLimit({
  windowMs,
  max: env.rateLimitRegisterMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many sign-up attempts from this device. Please try again later.",
  },
});

export const loginIpLimiter = rateLimit({
  windowMs,
  max: env.rateLimitLoginIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts from this device. Please try again later.",
  },
});

// Counts FAILED attempts only, so a user who logs in successfully is never
// throttled by their own earlier typos.
export const loginEmailLimiter = rateLimit({
  windowMs,
  max: env.rateLimitLoginMax,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: {
    success: false,
    message: "Too many failed login attempts. Please try again later.",
  },
});

export const resendVerificationIpLimiter = rateLimit({
  windowMs,
  max: env.rateLimitResendVerificationIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this device. Please try again later.",
  },
});

// Keyed on the submitted address whether or not an account exists, so the
// 429 itself can't be used to probe for accounts.
export const resendVerificationEmailLimiter = rateLimit({
  windowMs,
  max: env.rateLimitResendVerificationMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

// Tokens are 256-bit, so guessing is hopeless; this just bounds junk traffic.
export const verifyEmailLimiter = rateLimit({
  windowMs,
  max: env.rateLimitVerifyEmailMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many verification attempts. Please try again later.",
  },
});

// --- Password reset ----------------------------------------------------------
// Same shape as the resend-verification pair: the per-email bucket is keyed on
// the submitted address whether or not an account exists, so a 429 can't be
// used to probe for accounts.
export const forgotPasswordIpLimiter = rateLimit({
  windowMs,
  max: env.rateLimitForgotPasswordIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this device. Please try again later.",
  },
});

export const forgotPasswordEmailLimiter = rateLimit({
  windowMs,
  max: env.rateLimitForgotPasswordMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

// Tokens are 256-bit, so guessing is hopeless; this just bounds junk traffic.
export const resetPasswordLimiter = rateLimit({
  windowMs,
  max: env.rateLimitResetPasswordMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again later.",
  },
});

// Public storefront popup analytics beacons (POST /api/popups/:id/events).
// Per-IP; a visitor produces a handful of events per page view, so the cap
// only bites on a script inflating counters.
export const popupEventLimiter = rateLimit({
  windowMs,
  max: env.rateLimitPopupEventMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this device. Please try again later.",
  },
});
