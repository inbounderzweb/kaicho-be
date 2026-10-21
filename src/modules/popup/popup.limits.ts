// Single source of truth (server side) for every bound on popup timing and
// dismissal. The Mongoose schema, Zod validation and the public-DTO clamp all
// read from here; kaicho-ui/lib/popup/limits.ts mirrors it for UX only.

export const POPUP_LIMITS = {
  initialDelaySeconds: { min: 0, max: 300 },
  autoCloseAfterSeconds: { min: 3, max: 300 },
  // Hard ceiling on how long ANY popup may stay open, whatever else is
  // configured. This is the "never trap the visitor" backstop.
  maxDisplaySeconds: { min: 5, max: 600, default: 60 },
  sessionDisplayLimit: { min: 1, max: 10 },
  // 0 = do not repeat within a session.
  repeatIntervalSeconds: { min: 0, max: 86_400 },
  minReappearanceSeconds: { min: 5, max: 86_400 },
  dismissalWaitSeconds: { min: 60, max: 2_592_000 },
  // When early dismissal is disabled, controls unlock when the auto-close
  // timer fires, so that timer may not exceed this.
  earlyDismissLockMaxSeconds: 10,
  maxIncludePaths: 20,
} as const;

// Routes where a popup must never appear: the money path, authentication and
// the admin area. Mirrored by the storefront runtime.
export const POPUP_EXCLUDED_PATH_PREFIXES = [
  "/admin",
  "/checkout",
  "/cart",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/payment",
  "/orders",
  "/profile",
] as const;
