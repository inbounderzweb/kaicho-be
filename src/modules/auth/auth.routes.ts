import { Router } from "express";
import { sendOtp, verifyOtp, googleAuth, getMe, logout, updateMe } from "./auth.controller";
import { sendOtpSchema, verifyOtpSchema, updateMeSchema, googleAuthSchema } from "./auth.validation";
import {
  validateBody,
  otpIpLimiter,
  otpPhoneLimiter,
  requireAuth,
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

router.get("/me", requireAuth, getMe);

router.patch("/me", requireAuth, validateBody(updateMeSchema), updateMe);

router.post("/logout", logout);

export default router;
