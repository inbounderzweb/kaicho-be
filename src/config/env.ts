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

  rateLimitWindowMinutes: requiredInt("RATE_LIMIT_WINDOW_MINUTES", 10),
  rateLimitOtpMax: requiredInt("RATE_LIMIT_OTP_MAX", 10),
  // Public inquiry-form submissions, per IP, per RATE_LIMIT_WINDOW_MINUTES.
  rateLimitInquiryMax: requiredInt("RATE_LIMIT_INQUIRY_MAX", 10),
  // Public /api/location/* calls, per IP, per RATE_LIMIT_WINDOW_MINUTES.
  // Generous — one visitor legitimately fires several (detect + a few search
  // keystrokes + serviceability) — but caps a script hammering the proxy.
  rateLimitLocationMax: requiredInt("RATE_LIMIT_LOCATION_MAX", 120),

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

  // "local" writes to disk under mediaBasePath, served by app.ts's static
  // mount. "cloudinary" ships the same bytes to a Cloudinary bucket instead —
  // see modules/media/storage/CloudinaryStorageProvider.ts. Nothing else in
  // the app needs to change when switching; every consumer goes through
  // getStorageProvider() (modules/media/storage/index.ts).
  storageProvider: required("STORAGE_PROVIDER", "local") as "local" | "cloudinary",
  mediaBasePath: required("MEDIA_BASE_PATH", "uploads/media"),
  // Only required when storageProvider is "cloudinary" (validated there, not
  // here, so "local" dev/test setups never need these set). Get these from
  // the Cloudinary dashboard (Settings → API Keys) — never commit real
  // values, only placeholders belong in .env.example.
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || undefined,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || undefined,
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || undefined,
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

  // Courier aggregator (Shiprocket etc.). Empty by default — shipments are
  // entered manually today (Order.shipment.provider === "manual"). When a
  // client is added it lives behind shipment.service.ts's saveShipment(), the
  // same seam refunds use for Razorpay; nothing else needs to change here.
  shiprocketEmail: required("SHIPROCKET_EMAIL", ""),
  shiprocketPassword: required("SHIPROCKET_PASSWORD", ""),
};
