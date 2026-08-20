import { Router } from "express";
import { sendOtp, verifyOtp, getMe, logout, updateMe } from "./auth.controller";
import { sendOtpSchema, verifyOtpSchema, updateMeSchema } from "./auth.validation";
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

router.get("/me", requireAuth, getMe);

router.patch("/me", requireAuth, validateBody(updateMeSchema), updateMe);

router.post("/logout", logout);

export default router;
