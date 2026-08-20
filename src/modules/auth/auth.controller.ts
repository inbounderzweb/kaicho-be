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

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.body;
  const user = await authService.updateName(req.userId!, name);
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
    message: "Logged out successfully",
  });
});
