import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import { generateOtp, hashOtp, compareOtp } from "../../common/utils/otp";
import { getSmsProvider } from "../../common/sms";
import { OtpVerification, User, UserDocument } from "../../database/models";

const PURPOSE = "login";

export interface AuthUserDto {
  id: string;
  phone?: string;
  countryCode: string;
  phoneVerified: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailVerified: boolean;
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
    emailVerified: user.emailVerified,
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
      // `retryAfter` is the machine-readable form of the number in the
      // message — the client uses it to drive a live countdown instead of
      // showing a frozen "wait 28s".
      throw new AppError(`Please wait ${wait}s before requesting another OTP`, 429, true, {
        retryAfter: wait,
      });
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
  const data:any = message
  return data
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

  // Dev-only escape hatch: the console SMS provider prints the real OTP to
  // this process's own stdout, not somewhere a browser-driving tool or a
  // second person can read. Gated on nodeEnv so it's structurally inert
  // outside development, regardless of what DEV_OTP_BYPASS_CODE is set to.
  const isDevBypass = env.nodeEnv === "development" && otp === env.devOtpBypassCode;
  const isMatch = isDevBypass || (await compareOtp(otp, record.otpHash));

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

// --- Google Sign-In --------------------------------------------------------

// Stateless verifier — no secret. verifyIdToken() checks the token's
// signature against Google's published keys, that `aud` equals our client id,
// that `iss` is accounts.google.com, and that it hasn't expired. The keys are
// fetched and cached inside the client.
const googleClient = new OAuth2Client();

interface GoogleProfile {
  sub: string;
  email?: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  picture?: string;
}

async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  if (!env.googleClientId) {
    throw new AppError("Google sign-in is not configured on this server.", 501);
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: env.googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AppError("Could not verify your Google sign-in. Please try again.", 401);
  }

  if (!payload?.sub) {
    throw new AppError("Could not verify your Google sign-in. Please try again.", 401);
  }

  return {
    sub: payload.sub,
    email: payload.email?.toLowerCase(),
    emailVerified: payload.email_verified === true,
    firstName: payload.given_name,
    lastName: payload.family_name,
    picture: payload.picture,
  };
}

export async function loginWithGoogle(credential: string): Promise<VerifyOtpResult> {
  const profile = await verifyGoogleCredential(credential);

  if (!profile.email || !profile.emailVerified) {
    throw new AppError("Your Google account has no verified email address.", 400);
  }

  // Match on the Google user id first; fall back to an existing account with
  // the same email (an OTP user adding Google as a second way in) — safe
  // because Google has just told us the email is verified.
  let user = await User.findOne({ googleId: profile.sub }).exec();
  if (!user) {
    user = await User.findOne({ email: profile.email }).exec();
  }

  if (user) {
    if (!user.googleId) user.googleId = profile.sub;
    if (!user.email) user.email = profile.email;
    user.emailVerified = true;
    if (!user.firstName && profile.firstName) user.firstName = profile.firstName;
    if (!user.lastName && profile.lastName) user.lastName = profile.lastName;
    if (!user.avatar && profile.picture) user.avatar = profile.picture;
    user.lastLoginAt = new Date();
    await user.save();
  } else {
    user = await User.create({
      googleId: profile.sub,
      email: profile.email,
      emailVerified: true,
      countryCode: env.defaultCountryCode,
      firstName: profile.firstName,
      lastName: profile.lastName,
      avatar: profile.picture,
      lastLoginAt: new Date(),
    });
  }

  const token = signSessionToken(user);
  return { token, user: toUserDto(user), requiresName: !user.firstName };
}

export interface UpdateProfileInput {
  name?: string;
  phone?: string;
  countryCode?: string;
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput
): Promise<AuthUserDto> {
  const set: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const [firstName, ...rest] = input.name.split(/\s+/).filter(Boolean);
    set.firstName = firstName;
    set.lastName = rest.join(" ") || undefined;
  }

  if (input.phone !== undefined) {
    // Belt: reject an obvious clash up front with a clear message. Braces:
    // the sparse-unique index on `phone` is the real guard against a race —
    // caught as 11000 below.
    const clash = await User.findOne({ phone: input.phone, _id: { $ne: userId } })
      .select("_id")
      .lean();
    if (clash) {
      throw new AppError("That mobile number is already linked to another account.", 409);
    }
    set.phone = input.phone;
    if (input.countryCode) set.countryCode = input.countryCode;
  }

  let user: UserDocument | null;
  try {
    user = await User.findByIdAndUpdate(
      userId,
      { $set: set },
      { returnDocument: "after" }
    ).exec();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new AppError("That mobile number is already linked to another account.", 409);
    }
    throw err;
  }

  if (!user) {
    throw new AppError("Not authenticated", 401);
  }

  return toUserDto(user);
}
