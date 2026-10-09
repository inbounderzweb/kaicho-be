import crypto from "crypto";
import bcrypt from "bcrypt";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import { sendEmail, maskEmail } from "../../common/email/email.service";
import { verificationEmail } from "../../common/email/templates";
import { EmailVerificationToken, User, UserDocument } from "../../database/models";
import { AuthUserDto, signSessionToken, toUserDto } from "./auth.service";

export interface SessionResult {
  token: string;
  user: AuthUserDto;
  requiresName: boolean;
}

export const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";

const INVALID_LINK_MESSAGE = "Verification link is invalid or expired.";

// --- helpers ---------------------------------------------------------------

// High-entropy random token -> a fast unsalted hash is the right tool here
// (bcrypt's slowness only matters for low-entropy secrets like passwords).
function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function verificationLink(rawToken: string): string {
  const base = env.appUrl ?? env.frontendOrigins[0];
  return `${base}/verify-email?token=${rawToken}`;
}

// Compared against when the account doesn't exist (or has no password) so a
// login for an unknown email costs the same bcrypt work as a real one.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(crypto.randomBytes(16).toString("hex"), env.bcryptRounds);
  return dummyHash;
}

function splitName(fullName: string): { firstName: string; lastName?: string } {
  const [firstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
  return { firstName, lastName: rest.join(" ") || undefined };
}

function displayName(user: Pick<UserDocument, "firstName">): string {
  return user.firstName || "there";
}

// Replaces any previous token for the user (so an older emailed link stops
// working), stores only the hash, and returns the raw token for the email.
async function issueVerificationToken(userId: UserDocument["_id"]): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  await EmailVerificationToken.deleteMany({ userId });
  await EmailVerificationToken.create({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + env.emailVerificationExpiryMinutes * 60 * 1000),
  });
  return rawToken;
}

async function withinResendCooldown(userId: UserDocument["_id"]): Promise<boolean> {
  const last = await EmailVerificationToken.findOne({ userId })
    .sort({ createdAt: -1 })
    .select("createdAt")
    .lean();
  if (!last) return false;
  return Date.now() - last.createdAt.getTime() < env.emailVerificationResendCooldownSeconds * 1000;
}

// Issues a fresh token and emails it. Never throws: a provider outage must
// not turn into a 500 that reveals whether the account existed, and the user
// can always use "resend". The failure is logged WITHOUT the link.
async function sendVerification(user: UserDocument & { email?: string }): Promise<void> {
  console.log("<><>working 003")
  if (!user.email) return;
  try {
    const rawToken = await issueVerificationToken(user._id);
    const { subject, html, text } = verificationEmail({
      name: displayName(user),
      link: verificationLink(rawToken),
      expiryMinutes: env.emailVerificationExpiryMinutes,
    });
    await sendEmail({ to: user.email, subject, html, text });
  } catch (err) {
    console.error(
      `[auth] failed to send verification email to ${maskEmail(user.email)}:`,
      err instanceof Error ? err.message : "unknown error"
    );
  }
}

// --- register --------------------------------------------------------------

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

// Always resolves the same way whether or not the email was already taken,
// so the endpoint can't be used to discover who has an account.
export async function register(input: RegisterInput): Promise<void> {
  // Hash up front, even for an email we'll end up ignoring, so response time
  // doesn't separate "new" from "already registered".
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  const { firstName, lastName } = splitName(input.name);

  const existing = await User.findOne({ email: input.email }).exec();
console.log("<><>register 002",existing)
  if (existing) {
    // A verified account (password, Google, ...) is never touched by a
    // registration attempt - that would be an account takeover.
    //
    // An UNVERIFIED one belongs to nobody yet: the latest registrant wins, so
    // someone can't squat an address with a password they know and leave the
    // real owner stuck. Only the mailbox owner can complete verification.
    if (!existing.emailVerified && existing.isActive) {
      existing.passwordHash = passwordHash;
      existing.firstName = firstName;
      existing.lastName = lastName;
      await existing.save();
      if (!(await withinResendCooldown(existing._id))) {
        await sendVerification(existing);
      }
    }
    console.log("<><>register 003")
    return;
  }
  let user: UserDocument;
  try {
    user = await User.create({
      email: input.email,
      emailVerified: false,
      passwordHash,
      firstName,
      lastName,
      countryCode: env.defaultCountryCode,
    });
  } catch (err) {
    // Lost a race with a concurrent registration for the same email - the
    // unique index did its job; behave exactly like the "existing" branch.
    if ((err as { code?: number }).code === 11000) return;
    throw err;
  }

  await sendVerification(user);
}

// --- verify ----------------------------------------------------------------

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url

export async function verifyEmail(rawToken: string): Promise<SessionResult> {
  if (!TOKEN_SHAPE.test(rawToken)) {
    throw new AppError(INVALID_LINK_MESSAGE, 400);
  }

  // Atomic find-and-delete: of two concurrent requests with the same token,
  // exactly one gets the document. That is what makes the link single-use.
  const record = await EmailVerificationToken.findOneAndDelete({
    tokenHash: hashToken(rawToken),
    expiresAt: { $gt: new Date() },
  }).exec();

  if (!record) {
    throw new AppError(INVALID_LINK_MESSAGE, 400);
  }

  const user = await User.findById(record.userId).exec();
  if (!user || !user.isActive) {
    throw new AppError(INVALID_LINK_MESSAGE, 400);
  }

  user.emailVerified = true;
  user.lastLoginAt = new Date();
  await user.save();

  return { token: signSessionToken(user), user: toUserDto(user), requiresName: !user.firstName };
}

// --- resend ----------------------------------------------------------------

// Silent no-op for every case except "unverified password account that is
// outside its cooldown" - the caller returns the same generic response
// regardless.
export async function resendVerification(email: string): Promise<void> {
  const user = await User.findOne({ email }).select("+passwordHash").exec();
  if (!user || user.emailVerified || !user.isActive || !user.passwordHash) return;
  if (await withinResendCooldown(user._id)) return;
  await sendVerification(user);
}

// --- login -----------------------------------------------------------------

export async function loginWithPassword(email: string, password: string): Promise<SessionResult> {
  const user = await User.findOne({ email }).select("+passwordHash").exec();

  // One message for "no such user", "no password on this account" (Google /
  // OTP-only) and "wrong password".
  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !user.passwordHash || !passwordOk) {
    throw new AppError("Invalid email or password.", 401);
  }

  // Only reached with the CORRECT password, so telling the caller the email
  // is unverified discloses nothing to someone who doesn't already know it.
  if (!user.emailVerified) {
    throw new AppError("Please verify your email before logging in.", 403, true, {
      code: EMAIL_NOT_VERIFIED,
    });
  }

  if (!user.isActive) {
    throw new AppError("This account has been disabled. Please contact support.", 403);
  }

  user.lastLoginAt = new Date();
  await user.save();

  return { token: signSessionToken(user), user: toUserDto(user), requiresName: !user.firstName };
}
