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

// Like requiredInt but allows decimals (e.g. 1.5 MB); a malformed value falls
// back rather than becoming NaN, which would silently disable a size cap.
function requiredNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  nodeEnv: required("NODE_ENV", "development"),
  port: requiredInt("PORT", 4000),
  mongoUri: required("MONGO_URI", "mongodb://localhost:27017/kaicho"),
  jwtSecret: required("JWT_SECRET", "change-me"),
  adminKey: required("ADMIN_KEY", "change-me-admin-key"),

  // Number of HTTP worker processes to fork (see server.ts). 1 = single
  // process (dev default). Set to the host's CPU count in production so a
  // slow request on one worker doesn't stall the other 99 users.
  webConcurrency: requiredInt("WEB_CONCURRENCY", 1),
  // Mongo connection-pool size PER worker. Total sockets to the DB is
  // roughly webConcurrency * mongoPoolSize — keep that under the cluster's
  // connection limit (Atlas M0 ~= 500, but throttles long before that).
  mongoPoolSize: requiredInt("MONGO_POOL_SIZE", 20),
  // Cache-Control max-age (seconds) for public catalog GET responses. The
  // frontend layers its own Data Cache on top; this is the shared/CDN hint.
  publicCacheMaxAge: requiredInt("PUBLIC_CACHE_MAX_AGE", 30),

  jwtExpiresIn: required("JWT_EXPIRES_IN", "30d"),

  cookieName: required("COOKIE_NAME", "kaicho_session"),
  cookieMaxAgeDays: requiredInt("COOKIE_MAX_AGE_DAYS", 30),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  cookieSameSite: required("COOKIE_SAME_SITE", "lax") as "lax" | "strict" | "none",
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : required("NODE_ENV", "development") === "production",

  // Allowed browser origins for CORS. Accepts a comma-separated list so more
  // than one frontend (local dev, a devtunnel, staging, prod) can talk to this
  // API at once. Each entry is trimmed and any trailing "/" is stripped, since
  // the browser's Origin header never carries a path or trailing slash — a
  // stored "https://foo.dev/" would otherwise never match and every request
  // from that origin would fail CORS.
  frontendOrigins: required("FRONTEND_ORIGIN", "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0),

  otpLength: requiredInt("OTP_LENGTH", 4),
  otpExpiryMinutes: requiredInt("OTP_EXPIRY_MINUTES", 5),
  otpMaxAttempts: requiredInt("OTP_MAX_ATTEMPTS", 5),
  otpResendCooldownSeconds: requiredInt("OTP_RESEND_COOLDOWN_SECONDS", 45),
  // Lets local/dev testing log in without reading the real OTP out of the
  // console SMS provider's stdout. Only ever honored when nodeEnv is
  // "development" (see auth.service.ts's verifyOtp) — never reachable in a
  // deployed environment regardless of what this is set to.
  devOtpBypassCode: required("DEV_OTP_BYPASS_CODE", "0000"),

  // --- Email/password auth + email verification ---------------------------
  // Public origin of the storefront, used ONLY to build the link in the
  // verification email. Taken from config, never from the request's
  // Host/Origin headers (a forged Host would otherwise poison the link).
  // Falls back to the first FRONTEND_ORIGIN entry.
  appUrl: (process.env.APP_URL || "").trim().replace(/\/+$/, "") || undefined,
  emailVerificationExpiryMinutes: requiredInt("EMAIL_VERIFICATION_EXPIRY_MINUTES", 30),
  // Minimum gap between two verification emails for the same account.
  emailVerificationResendCooldownSeconds: requiredInt("EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS", 60),
  passwordResetExpiryMinutes: requiredInt("PASSWORD_RESET_EXPIRY_MINUTES", 30),
  // Minimum gap between two reset emails for the same account.
  passwordResetCooldownSeconds: requiredInt("PASSWORD_RESET_COOLDOWN_SECONDS", 60),
  bcryptRounds: requiredInt("BCRYPT_ROUNDS", 12),

  // Number of reverse-proxy hops in front of this process (Express "trust
  // proxy"). Needed so per-IP rate limits see the real client IP instead of
  // the proxy's. Unset = trust none (req.ip is the socket peer).
  trustProxyHops: process.env.TRUST_PROXY ? parseInt(process.env.TRUST_PROXY, 10) : undefined,

  // Per-EMAIL cap on failed logins, and a looser per-IP backstop.
  rateLimitLoginMax: requiredInt("RATE_LIMIT_LOGIN_MAX", 10),
  rateLimitLoginIpMax: requiredInt("RATE_LIMIT_LOGIN_IP_MAX", 30),
  rateLimitRegisterMax: requiredInt("RATE_LIMIT_REGISTER_MAX", 10),
  rateLimitVerifyEmailMax: requiredInt("RATE_LIMIT_VERIFY_EMAIL_MAX", 30),
  rateLimitResendVerificationMax: requiredInt("RATE_LIMIT_RESEND_VERIFICATION_MAX", 5),
  rateLimitForgotPasswordMax: requiredInt("RATE_LIMIT_FORGOT_PASSWORD_MAX", 5),
  rateLimitForgotPasswordIpMax: requiredInt("RATE_LIMIT_FORGOT_PASSWORD_IP_MAX", 10),
  rateLimitResetPasswordMax: requiredInt("RATE_LIMIT_RESET_PASSWORD_MAX", 20),
  rateLimitResendVerificationIpMax: requiredInt("RATE_LIMIT_RESEND_VERIFICATION_IP_MAX", 10),

  rateLimitWindowMinutes: requiredInt("RATE_LIMIT_WINDOW_MINUTES", 10),
  rateLimitOtpMax: requiredInt("RATE_LIMIT_OTP_MAX", 10),
  // Public inquiry-form submissions, per IP, per RATE_LIMIT_WINDOW_MINUTES.
  rateLimitInquiryMax: requiredInt("RATE_LIMIT_INQUIRY_MAX", 10),
  // Public /api/location/* calls, per IP, per RATE_LIMIT_WINDOW_MINUTES.
  // Generous — one visitor legitimately fires several (detect + a few search
  // keystrokes + serviceability) — but caps a script hammering the proxy.
  rateLimitLocationMax: requiredInt("RATE_LIMIT_LOCATION_MAX", 120),
  rateLimitPopupEventMax: requiredInt("RATE_LIMIT_POPUP_EVENT_MAX", 120),

  // --- Location / geocoding -------------------------------------------------
  // The storefront's "detect / choose your delivery area" feature calls
  // /api/location/* only; this backend module is the sole thing that talks to
  // a geocoding provider, so a key never reaches the browser and coordinates
  // never appear in a third-party URL/log via the client.
  locationProvider: required("LOCATION_PROVIDER", "nominatim") as
    | "nominatim"
    | "google"
    | "mapbox",
  nominatimBaseUrl: required("NOMINATIM_BASE_URL", "https://nominatim.openstreetmap.org"),
  // OSM's usage policy requires an identifying User-Agent on every request.
  nominatimUserAgent: required("NOMINATIM_USER_AGENT", "KaichoFoods/1.0 (+https://kaicho.in)"),
  // Keyless IP-geolocation service for the approximate fallback.
  ipGeoBaseUrl: required("IP_GEO_BASE_URL", "https://ipapi.co"),
  // In-process cache TTL for reverse/search/serviceability results.
  locationCacheTtlMinutes: requiredInt("LOCATION_CACHE_TTL_MINUTES", 60),
  // Only needed if LOCATION_PROVIDER is switched to google/mapbox later.
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || undefined,
  mapboxToken: process.env.MAPBOX_TOKEN || undefined,

  smsProvider: required("SMS_PROVIDER", "console"),
  defaultCountryCode: required("DEFAULT_COUNTRY_CODE", "+91"),

  // Google Sign-In (OAuth 2.0 Web client ID from the Google Cloud console —
  // "APIs & Services → Credentials"). The SAME id must be set on the
  // frontend as NEXT_PUBLIC_GOOGLE_CLIENT_ID. No client secret is used: the
  // /api/auth/google endpoint verifies the ID token the browser sends
  // against Google's public keys and checks its audience equals this id.
  // Left undefined -> the endpoint responds 501 (feature not configured).
  googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,

  // "local" writes to disk under mediaBasePath, served by app.ts's static
  // mount. "r2" ships the same bytes to a Cloudflare R2 bucket instead —
  // see modules/media/storage/R2StorageProvider.ts. Nothing else in
  // the app needs to change when switching; every consumer goes through
  // getStorageProvider() (modules/media/storage/index.ts).
  storageProvider: required("STORAGE_PROVIDER", "local") as "local" | "r2" | "cloudinary",
  mediaBasePath: required("MEDIA_BASE_PATH", "uploads/media"),
  // Only required when storageProvider is "r2" (validated there, not here, so
  // "local" dev/test setups never need these set). Never commit real values,
  // only placeholders belong in .env.example.
  r2AccountId: process.env.R2_ACCOUNT_ID || undefined,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || undefined,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
  r2Bucket: process.env.R2_BUCKET || undefined,
  // Top-level folder inside the bucket, so dev and prod data never mix even
  // on one bucket. Defaults to "production" when NODE_ENV=production, else
  // "development"; override with R2_KEY_PREFIX. Applied inside the R2
  // provider only — stored storageKeys stay prefix-free.
  r2KeyPrefix: (
    process.env.R2_KEY_PREFIX ||
    (process.env.NODE_ENV === "production" ? "production" : "development")
  ).replace(/^\/+|\/+$/g, ""),
  // Public base URL objects are served from (custom domain or r2.dev URL).
  r2PublicUrl: process.env.R2_PUBLIC_URL || undefined,
  // Only required when storageProvider is "cloudinary" (validated in
  // CloudinaryStorageProvider).
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || undefined,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || undefined,
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || undefined,
  maxImageFileSizeMb: requiredNumber("MAX_IMAGE_FILE_SIZE_MB", 1.5),
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

  // Coupon-code validation attempts, per logged-in user, per
  // RATE_LIMIT_WINDOW_MINUTES. Tighter than checkout: this is the endpoint a
  // script would hammer to enumerate valid codes.
  rateLimitCouponValidateMax: requiredInt("RATE_LIMIT_COUPON_VALIDATE_MAX", 20),

  // MASTER SWITCH for the whole interaction-history feature. Off (the
  // default): nothing is recorded, buffered, swept or asked for, and the
  // storefront stops showing the consent prompt. Existing data is untouched.
  interactionTrackingEnabled: (process.env.INTERACTION_TRACKING_ENABLED ?? "false").trim().toLowerCase() === "true",
  // Interaction tracking (modules/interaction). Events from one user, per
  // RATE_LIMIT_WINDOW_MINUTES - batches of up to 20 count as one request.
  rateLimitInteractionMax: requiredInt("RATE_LIMIT_INTERACTION_MAX", 120),
  // Raw interaction events are deleted by a TTL index after this many days.
  interactionRetentionDays: requiredInt("INTERACTION_RETENTION_DAYS", 180),
  // Server-side tracking buffer: max events held in memory per process before
  // new ones are dropped (backpressure), and the max age before a flush.
  interactionBufferMax: requiredInt("INTERACTION_BUFFER_MAX", 5000),
  interactionFlushIntervalMs: requiredInt("INTERACTION_FLUSH_INTERVAL_MS", 2000),

  // Courier aggregator (Shiprocket etc.). Empty by default — shipments are
  // entered manually today (Order.shipment.provider === "manual"). When a
  // client is added it lives behind shipment.service.ts's saveShipment(), the
  // same seam refunds use for Razorpay; nothing else needs to change here.
  shiprocketEmail: required("SHIPROCKET_EMAIL", ""),
  shiprocketPassword: required("SHIPROCKET_PASSWORD", ""),

  // Shared email delivery (auth, customer order updates and admin alerts).
  // The app boots without SMTP; sendEmail reports missing configuration to
  // callers, which log delivery failures without undoing saved orders.
  // Any standard SMTP provider works (Gmail app password, SES SMTP relay).
  smtpHost: required("SMTP_HOST", ""),
  smtpPort: requiredInt("SMTP_PORT", 587),
  smtpUser: required("SMTP_USER", ""),
  smtpPass: required("SMTP_PASS", ""),
  smtpFrom: required("SMTP_FROM", ""),
  // Recipient(s) for the new-order email — comma-separated for more than one
  // admin inbox.
  adminNotificationEmail: required("ADMIN_NOTIFICATION_EMAIL", ""),

  // GA4 Measurement Protocol — server-to-server purchase tracking (see
  // common/analytics/ga4.ts), independent of the browser/GTM pipeline. Empty
  // by default so the app keeps booting without it configured, same
  // dev-safe pattern as the SMTP/Razorpay placeholders above; ga4.ts treats
  // a missing id/secret as "disabled" and only logs. Measurement ID is the
  // G-XXXXXXX from the GA4 property; the API secret is generated at GA4
  // Admin → Data Streams → (your web stream) → Measurement Protocol API
  // secrets → Create — NOT the same thing as the GTM container ID.
  ga4MeasurementId: required("GA4_MEASUREMENT_ID", ""),
  ga4ApiSecret: required("GA4_API_SECRET", ""),

  // WhatsApp Cloud API (Meta). Blank = webhook endpoint rejects everything
  // (fails closed). VERIFY_TOKEN is any string you invent and also type into
  // Meta's "Verify token" box; APP_SECRET (App settings -> Basic) signs every
  // POST via X-Hub-Signature-256.
  whatsappVerifyToken: required("WHATSAPP_VERIFY_TOKEN", ""),
  whatsappAppSecret: required("WHATSAPP_APP_SECRET", ""),
  whatsappAccessToken: required("WHATSAPP_ACCESS_TOKEN", ""),
  whatsappPhoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID", ""),
  whatsappBusinessAccountId: required("WHATSAPP_BUSINESS_ACCOUNT_ID", ""),
  // Approved Authentication template used for OTPs (WhatsApp Manager ->
  // Message templates). Its body must take one {{1}} parameter (the code).
  whatsappOtpTemplate: required("WHATSAPP_OTP_TEMPLATE", "otp_code"),
  whatsappTemplateLang: required("WHATSAPP_TEMPLATE_LANG", "en"),
  whatsappApiVersion: required("WHATSAPP_API_VERSION", "v21.0"),
};
