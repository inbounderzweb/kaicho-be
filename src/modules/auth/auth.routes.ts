import { Router } from "express";
import {
  sendOtp,
  verifyOtp,
  googleAuth,
  getMe,
  logout,
  updateMe,
  register,
  login,
  verifyEmail,
  resendVerification,
} from "./auth.controller";
import {
  sendOtpSchema,
  verifyOtpSchema,
  updateMeSchema,
  googleAuthSchema,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
} from "./auth.validation";
import {
  validateBody,
  otpIpLimiter,
  otpPhoneLimiter,
  requireAuth,
  registerIpLimiter,
  loginIpLimiter,
  loginEmailLimiter,
  resendVerificationIpLimiter,
  resendVerificationEmailLimiter,
  verifyEmailLimiter,
} from "../../common/middleware";

const router = Router();

router.post(
  "/send-otp",
  otpIpLimiter,
  validateBody(sendOtpSchema),
  otpPhoneLimiter,
  sendOtp
);

router.post(
  "/verify-otp",
  otpIpLimiter,
  validateBody(verifyOtpSchema),
  otpPhoneLimiter,
  verifyOtp
);

// Same per-IP limiter as the OTP routes — a login endpoint that mints a
// session, so it gets the same brute-force ceiling.
router.post("/google", otpIpLimiter, validateBody(googleAuthSchema), googleAuth);

// --- Email/password + email verification -------------------------------------
// Limiters that key on the email run AFTER validateBody so they see the
// normalized address (case/whitespace variants share one bucket).
router.post("/register", registerIpLimiter, validateBody(registerSchema), register);

router.post("/login", loginIpLimiter, validateBody(loginSchema), loginEmailLimiter, login);

// POST (not GET): consuming a single-use token and minting a session must not
// be triggerable by a link prefetcher/email scanner or a cross-site <img>.
router.post("/verify-email", verifyEmailLimiter, validateBody(verifyEmailSchema), verifyEmail);

router.post(
  "/resend-verification",
  resendVerificationIpLimiter,
  validateBody(resendVerificationSchema),
  resendVerificationEmailLimiter,
  resendVerification
);

router.get("/me", requireAuth, getMe);

router.patch("/me", requireAuth, validateBody(updateMeSchema), updateMe);

router.post("/logout", logout);

export default router;
