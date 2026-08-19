import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { setSessionCookie, clearSessionCookie } from "../../common/utils/cookies";
import { AppError } from "../../common/errors";
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
  const { token, user } = await authService.verifyOtp(phone, otp, countryCode);
  setSessionCookie(res, token);
  res.status(200).json({
    success: true,
    message: "Logged in successfully",
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

export const logout = asyncHandler(async (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});
