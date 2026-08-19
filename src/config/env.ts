import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredInt(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined ? fallback : parseInt(raw, 10);
}

export const env = {
  nodeEnv: required("NODE_ENV", "development"),
  port: requiredInt("PORT", 4000),
  mongoUri: required("MONGO_URI", "mongodb://localhost:27017/kaicho"),
  jwtSecret: required("JWT_SECRET", "change-me"),
  adminKey: required("ADMIN_KEY", "change-me-admin-key"),

  jwtExpiresIn: required("JWT_EXPIRES_IN", "30d"),

  cookieName: required("COOKIE_NAME", "kaicho_session"),
  cookieMaxAgeDays: requiredInt("COOKIE_MAX_AGE_DAYS", 30),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  cookieSameSite: required("COOKIE_SAME_SITE", "lax") as "lax" | "strict" | "none",
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : required("NODE_ENV", "development") === "production",

  frontendOrigin: required("FRONTEND_ORIGIN", "http://localhost:3000"),

  otpLength: requiredInt("OTP_LENGTH", 4),
  otpExpiryMinutes: requiredInt("OTP_EXPIRY_MINUTES", 5),
  otpMaxAttempts: requiredInt("OTP_MAX_ATTEMPTS", 5),
  otpResendCooldownSeconds: requiredInt("OTP_RESEND_COOLDOWN_SECONDS", 45),

  rateLimitWindowMinutes: requiredInt("RATE_LIMIT_WINDOW_MINUTES", 10),
  rateLimitOtpMax: requiredInt("RATE_LIMIT_OTP_MAX", 10),

  smsProvider: required("SMS_PROVIDER", "console"),
  defaultCountryCode: required("DEFAULT_COUNTRY_CODE", "+91"),
};
