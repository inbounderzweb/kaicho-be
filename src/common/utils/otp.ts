import crypto from "crypto";
import bcrypt from "bcrypt";

const SALT_ROUNDS = 10;

export function generateOtp(length: number): string {
  const max = Math.pow(10, length);
  return crypto.randomInt(0, max).toString().padStart(length, "0");
}

export function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, SALT_ROUNDS);
}

export function compareOtp(otp: string, otpHash: string): Promise<boolean> {
  return bcrypt.compare(otp, otpHash);
}
