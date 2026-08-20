import { z } from "zod";
import { env } from "../../config/env";

const otpPattern = new RegExp(`^\\d{${env.otpLength}}$`);

const phoneField = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ""))
  .pipe(
    z
      .string()
      .regex(/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number")
  );

export const sendOtpSchema = z.object({
  phone: phoneField,
  countryCode: z.string().trim().optional(),
});

export const verifyOtpSchema = z.object({
  phone: phoneField,
  countryCode: z.string().trim().optional(),
  otp: z
    .string()
    .trim()
    .regex(otpPattern, `Please enter the ${env.otpLength}-digit OTP`),
});

export const updateMeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Please enter your name")
    .max(80, "Name is too long"),
});

export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
