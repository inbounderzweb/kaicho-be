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
