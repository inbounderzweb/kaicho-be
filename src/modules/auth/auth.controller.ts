import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { setSessionCookie, clearSessionCookie } from "../../common/utils/cookies";
import { AppError } from "../../common/errors";
import { env } from "../../config/env";
import { User } from "../../database/models";
import * as authService from "./auth.service";
import * as emailAuth from "./emailAuth.service";

export const sendOtp = asyncHandler(async (req: Request, res: Response) => {
  const { phone, countryCode } = req.body;
 const resdata =  await authService.sendOtp(phone, countryCode);
  res.status(200).json({
    success: true,
    // Deliberately no OTP in the body — it goes out over SMS only.
    // `resendAfter` lets the client run its "Resend OTP in 00:xx" countdown
    // off the server's actual cooldown rather than a hardcoded guess.
    data: { sent: true, resendAfter: env.otpResendCooldownSeconds,otp:resdata },
    message: "OTP sent successfully",
  });
});

export const verifyOtp = asyncHandler(async (req: Request, res: Response) => {
  const { phone, otp, countryCode } = req.body;
  const { token, user, requiresName } = await authService.verifyOtp(phone, otp, countryCode);
  setSessionCookie(res, token);
  res.status(200).json({
    success: true,
    message: "Logged in successfully",
    data: { user, requiresName },
  });
});

export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  const { credential } = req.body;
  const { token, user, requiresName } = await authService.loginWithGoogle(credential);
  setSessionCookie(res, token);
  res.status(200).json({
    success: true,
    message: "Logged in successfully",
    data: { user, requiresName },
  });
});

export const register = asyncHandler(async (req: Request, res: Response) => {
  console.log("<><>register 001");
  await emailAuth.register(req.body);
  // Same body whether the email was new or already taken (no enumeration).
  res.status(201).json({
    success: true,
    message:
      "Account created. Please check your email and click the verification link to activate your account.",
    data: { registered: true },
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { token, user, requiresName } = await emailAuth.loginWithPassword(
    req.body.email,
    req.body.password
  );
  setSessionCookie(res, token);
  res.status(200).json({
    success: true,
    message: "Logged in successfully",
    data: { user, requiresName },
  });
});

export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const { token, user, requiresName } = await emailAuth.verifyEmail(req.body.token);
  setSessionCookie(res, token);
  res.status(200).json({
    success: true,
    message: "Email verified successfully.",
    data: { user, requiresName },
  });
});

export const resendVerification = asyncHandler(async (req: Request, res: Response) => {
  console.log("<><>working");
  await emailAuth.resendVerification(req.body.email);
  res.status(200).json({
    success: true,
    message: "If the account exists and is not verified, a verification email has been sent.",
    data: { sent: true, resendAfter: env.emailVerificationResendCooldownSeconds },
  });
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  await emailAuth.requestPasswordReset(req.body.email);
  res.status(200).json({
    success: true,
    message: "If an account exists for that email, a password reset link has been sent.",
    data: { sent: true, resendAfter: env.passwordResetCooldownSeconds },
  });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await emailAuth.resetPassword(req.body.token, req.body.password);
  res.status(200).json({
    success: true,
    message: "Password updated. Please log in with your new password.",
    data: { reset: true },
  });
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  // req.body is already narrowed to { name?, phone?, countryCode? } by
  // validateBody(updateMeSchema).
  const user = await authService.updateProfile(req.userId!, req.body);
  res.status(200).json({
    success: true,
    message: "Profile updated",
    data: { user },
  });
});

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.userId).exec();
  if (!user) {
    throw new AppError("Not authenticated", 401);
  }
  res.status(200).json({
    success: true,
    data: { user: authService.toUserDto(user) },
  });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[env.cookieName];
  await authService.invalidateSession(token);
  clearSessionCookie(res);
  res.status(200).json({
    success: true,
    // The frontend's apiFetch rejects a 2xx whose body has no `data`, so
    // every endpoint returns one even when there's nothing to send back.
    data: { loggedOut: true },
    message: "Logged out successfully",
  });
});
