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
  // Lets local/dev testing log in without reading the real OTP out of the
  // console SMS provider's stdout. Only ever honored when nodeEnv is
  // "development" (see auth.service.ts's verifyOtp) — never reachable in a
  // deployed environment regardless of what this is set to.
  devOtpBypassCode: required("DEV_OTP_BYPASS_CODE", "0000"),

  rateLimitWindowMinutes: requiredInt("RATE_LIMIT_WINDOW_MINUTES", 10),
  rateLimitOtpMax: requiredInt("RATE_LIMIT_OTP_MAX", 10),

  smsProvider: required("SMS_PROVIDER", "console"),
  defaultCountryCode: required("DEFAULT_COUNTRY_CODE", "+91"),

  storageProvider: required("STORAGE_PROVIDER", "local"),
  mediaBasePath: required("MEDIA_BASE_PATH", "uploads/media"),
  maxImageFileSizeMb: requiredInt("MAX_IMAGE_FILE_SIZE_MB", 10),
  maxPdfFileSizeMb: requiredInt("MAX_PDF_FILE_SIZE_MB", 20),
  maxMediaFilesPerRequest: requiredInt("MAX_MEDIA_FILES_PER_REQUEST", 10),
  maxImageWidth: requiredInt("MAX_IMAGE_WIDTH", 8000),
  maxImageHeight: requiredInt("MAX_IMAGE_HEIGHT", 8000),
  imageThumbnailWidth: requiredInt("IMAGE_THUMBNAIL_WIDTH", 300),
  imageMediumWidth: requiredInt("IMAGE_MEDIUM_WIDTH", 800),
  imageOptimizedWidth: requiredInt("IMAGE_OPTIMIZED_WIDTH", 1600),
  mediaTemporaryTtlHours: requiredInt("MEDIA_TEMPORARY_TTL_HOURS", 24),

  rateLimitMediaUploadMax: requiredInt("RATE_LIMIT_MEDIA_UPLOAD_MAX", 30),
  rateLimitMediaDeleteMax: requiredInt("RATE_LIMIT_MEDIA_DELETE_MAX", 60),

  // Razorpay credentials. The empty-string fallbacks keep the app bootable
  // in development/tests without a gateway account (same dev-safe treatment
  // as jwtSecret/adminKey's placeholder values) — but any environment that
  // accepts real payments MUST set real values: with an empty secret every
  // HMAC signature check fails closed, so /payments/razorpay/verify and the
  // webhook will reject everything rather than accept anything.
  razorpayKeyId: required("RAZORPAY_KEY_ID", ""),
  razorpayKeySecret: required("RAZORPAY_KEY_SECRET", ""),
  razorpayWebhookSecret: required("RAZORPAY_WEBHOOK_SECRET", ""),

  rateLimitCheckoutMax: requiredInt("RATE_LIMIT_CHECKOUT_MAX", 20),
};
