import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import { generateOtp, hashOtp, compareOtp } from "../../common/utils/otp";
import { getSmsProvider } from "../../common/sms";
import { OtpVerification, User, UserDocument } from "../../database/models";

const PURPOSE = "login";

export interface AuthUserDto {
  id: string;
  phone: string;
  countryCode: string;
  phoneVerified: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  avatar?: string;
  role: UserDocument["role"];
  createdAt: Date;
  lastLoginAt?: Date;
}

export function toUserDto(user: UserDocument): AuthUserDto {
  return {
    id: user._id.toString(),
    phone: user.phone,
    countryCode: user.countryCode,
    phoneVerified: user.phoneVerified,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    avatar: user.avatar,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export function signSessionToken(user: UserDocument): string {
  return jwt.sign({ sub: user._id.toString(), tv: user.tokenVersion }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

export async function sendOtp(phone: string, countryCode?: string): Promise<void> {
  const lastOtp = await OtpVerification.findOne({ phone, purpose: PURPOSE })
    .sort({ createdAt: -1 })
    .exec();

  if (lastOtp) {
    const secondsSinceLast =
      (Date.now() - lastOtp.createdAt.getTime()) / 1000;
    if (secondsSinceLast < env.otpResendCooldownSeconds) {
      const wait = Math.ceil(env.otpResendCooldownSeconds - secondsSinceLast);
      throw new AppError(`Please wait ${wait}s before requesting another OTP`, 429);
    }
  }

  await OtpVerification.deleteMany({ phone, purpose: PURPOSE });

  const otp = generateOtp(env.otpLength);
  const otpHash = await hashOtp(otp);
  const expiresAt = new Date(Date.now() + env.otpExpiryMinutes * 60 * 1000);

  await OtpVerification.create({
    phone,
    otpHash,
    purpose: PURPOSE,
    expiresAt,
    attempts: 0,
    verified: false,
  });

  const message = `${otp} is your Kaicho verification code. Valid for ${env.otpExpiryMinutes} minutes.`;
  await getSmsProvider().sendSms(`${countryCode ?? env.defaultCountryCode}${phone}`, message);
}

// Best-effort: called from logout, which must succeed even if the presented
// cookie is missing, malformed, or already expired (the end state — "not
// logged in" — is already true in that case). Only bumps tokenVersion when
// a real, still-decodable session is found, which revokes that token (and
// any other copy of it) immediately, regardless of its original expiry.
export async function invalidateSession(token: string | undefined): Promise<void> {
  if (!token) return;

  let payload: { sub: string };
  try {
    payload = jwt.verify(token, env.jwtSecret, { ignoreExpiration: true }) as {
      sub: string;
    };
  } catch {
    return;
  }

  await User.findByIdAndUpdate(payload.sub, { $inc: { tokenVersion: 1 } }).exec();
}

export interface VerifyOtpResult {
  token: string;
  user: AuthUserDto;
  requiresName: boolean;
}

export async function verifyOtp(
  phone: string,
  otp: string,
  countryCode?: string
): Promise<VerifyOtpResult> {
  const record = await OtpVerification.findOne({
    phone,
    purpose: PURPOSE,
    verified: false,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .exec();

  if (!record) {
    throw new AppError("OTP expired or not requested. Please request a new one.", 400);
  }

  if (record.attempts >= env.otpMaxAttempts) {
    throw new AppError("Too many incorrect attempts. Please request a new OTP.", 400);
  }

  const isMatch = await compareOtp(otp, record.otpHash);

  if (!isMatch) {
    record.attempts += 1;
    await record.save();
    const remaining = env.otpMaxAttempts - record.attempts;
    if (remaining <= 0) {
      throw new AppError("Too many incorrect attempts. Please request a new OTP.", 400);
    }
    throw new AppError(`Incorrect OTP. ${remaining} attempt(s) remaining.`, 400);
  }

  record.verified = true;
  await record.save();

  let user = await User.findOne({ phone }).exec();
  if (!user) {
    user = await User.create({
      phone,
      countryCode: countryCode ?? env.defaultCountryCode,
      phoneVerified: true,
      lastLoginAt: new Date(),
    });
  } else {
    user.phoneVerified = true;
    user.lastLoginAt = new Date();
    await user.save();
  }

  const token = signSessionToken(user);

  return { token, user: toUserDto(user), requiresName: !user.firstName };
}

export async function updateName(userId: string, name: string): Promise<AuthUserDto> {
  const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
  const lastName = rest.join(" ");

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { firstName, lastName: lastName || undefined } },
    { returnDocument: "after" }
  ).exec();

  if (!user) {
    throw new AppError("Not authenticated", 401);
  }

  return toUserDto(user);
}
