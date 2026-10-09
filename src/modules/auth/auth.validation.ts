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

// PATCH /auth/me — a partial profile update. `name` alone (the login
// name-step), `phone` alone (a Google user adding the mobile number checkout
// requires), or both. At least one must be present.
export const updateMeSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Please enter your name")
      .max(80, "Name is too long")
      .optional(),
    phone: phoneField.optional(),
    countryCode: z.string().trim().optional(),
  })
  .refine((v) => v.name !== undefined || v.phone !== undefined, {
    message: "Provide a name or a mobile number to update",
  });

// The `credential` is the Google ID token (a JWT) returned by Google Identity
// Services in the browser. Bounds only — its contents are verified against
// Google's keys in auth.service.
export const googleAuthSchema = z.object({
  credential: z
    .string()
    .trim()
    .min(20, "Missing Google credential")
    .max(8192, "Malformed Google credential"),
});

// --- Email/password auth ----------------------------------------------------

// Trim + lowercase here so every downstream query, rate-limit key and unique
// index sees one canonical spelling. `.pipe(email())` runs after the transform.
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Please enter a valid email address").max(254, "Email is too long"));

// bcrypt only looks at the first 72 BYTES, so a longer password would be
// silently truncated - reject it instead.
const newPasswordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => Buffer.byteLength(v, "utf8") <= 72, "Password is too long (max 72 bytes)")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Password must include a letter and a number");

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Please enter your name").max(80, "Name is too long"),
  email: emailField,
  password: newPasswordField,
});

// Login deliberately does NOT apply the strength rules: an older account must
// still be able to log in, and the message for any bad input is generic.
export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Please enter your password").max(1024, "Password is too long"),
});

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1, "Verification link is invalid or expired.").max(256),
});

export const resendVerificationSchema = z.object({
  email: emailField,
});

export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
