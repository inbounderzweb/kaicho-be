import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { setSessionCookie, clearSessionCookie } from "../../common/utils/cookies";
import { AppError } from "../../common/errors";
import { env } from "../../config/env";
import { User } from "../../database/models";
import * as authService from "./auth.service";

export const sendOtp = asyncHandler(async (req: Request, res: Response) => {
  const { phone, countryCode } = req.body;
  await authService.sendOtp(phone, countryCode);
  res.status(200).json({
    success: true,
    // Deliberately no OTP in the body — it goes out over SMS only.
    data: { sent: true },
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
