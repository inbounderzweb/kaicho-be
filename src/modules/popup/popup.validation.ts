import { z } from "zod";
import {
  POPUP_STATUSES,
  POPUP_THEMES,
  POPUP_SIZES,
  DESKTOP_PLACEMENTS,
  MOBILE_PLACEMENTS,
  CLOSE_BUTTON_POSITIONS,
  CLOSE_BUTTON_SIZES,
  CLOSE_BUTTON_STYLES,
  DISMISSAL_POLICIES,
} from "../../database/models";
import { POPUP_LIMITS } from "./popup.limits";

const L = POPUP_LIMITS;

const intIn = (label: string, min: number, max: number) =>
  z
    .number({ message: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);

// Strict objects: an unknown key is a 400, never silently stored (spec §5 —
// structured fields, not arbitrary configuration objects).
export const timingSettingsSchema = z.strictObject({
  initialDelaySeconds: intIn("Initial delay (seconds)", L.initialDelaySeconds.min, L.initialDelaySeconds.max),
  autoCloseEnabled: z.boolean(),
  autoCloseAfterSeconds: intIn(
    "Auto-close timer (seconds)",
    L.autoCloseAfterSeconds.min,
    L.autoCloseAfterSeconds.max
  ),
  countdownVisible: z.boolean(),
  closeButtonEnabled: z.boolean(),
  closeButtonPosition: z.enum(CLOSE_BUTTON_POSITIONS),
  backdropDismissEnabled: z.boolean(),
  escapeDismissEnabled: z.boolean(),
});

const displaySchema = z.strictObject({
  maxDisplaySeconds: intIn("Maximum display time (seconds)", L.maxDisplaySeconds.min, L.maxDisplaySeconds.max),
  allowEarlyDismiss: z.boolean(),
  closeButtonSize: z.enum(CLOSE_BUTTON_SIZES),
  closeButtonStyle: z.enum(CLOSE_BUTTON_STYLES),
  dismissalPolicy: z.enum(DISMISSAL_POLICIES),
  dismissalWaitSeconds: intIn("Dismissal wait (seconds)", L.dismissalWaitSeconds.min, L.dismissalWaitSeconds.max),
  sessionDisplayLimit: intIn("Session display limit", L.sessionDisplayLimit.min, L.sessionDisplayLimit.max),
  repeatIntervalSeconds: intIn(
    "Repeat interval (seconds)",
    L.repeatIntervalSeconds.min,
    L.repeatIntervalSeconds.max
  ),
  showOnEveryLoad: z.boolean().optional(),
  minReappearanceSeconds: intIn(
    "Minimum reappearance delay (seconds)",
    L.minReappearanceSeconds.min,
    L.minReappearanceSeconds.max
  ),
});

const timingSchema = z.strictObject({
  useSharedTimingSettings: z.boolean(),
  shared: timingSettingsSchema,
  desktop: timingSettingsSchema,
  mobile: timingSettingsSchema,
});

// Link targets are limited to https URLs and same-site relative paths.
// `javascript:`, `data:` and protocol-relative `//host` are all rejected.
export function isSafePopupHref(value: string): boolean {
  if (value.startsWith("/")) return !value.startsWith("//") && !value.includes("\\");
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const hrefField = (label: string) =>
  z
    .string()
    .trim()
    .max(2048, `${label} is too long`)
    .refine(isSafePopupHref, `${label} must be an https:// URL or a path starting with /`);

const contentSchema = z.strictObject({
  heading: z.string().trim().max(120, "Heading must be at most 120 characters"),
  body: z.string().trim().max(500, "Body must be at most 500 characters"),
  imageUrl: hrefField("Image URL").optional(),
  desktopImageUrl: hrefField("Desktop banner image").optional(),
  mobileImageUrl: hrefField("Mobile banner image").optional(),
  imageAlt: z.string().trim().max(200).optional(),
  ctaLabel: z.string().trim().max(40, "Button label must be at most 40 characters").optional(),
  ctaUrl: hrefField("Button link").optional(),
});

const pathField = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v.startsWith("/") && !v.startsWith("//"), "Paths must start with a single /");

const dateField = z.union([z.string().datetime({ offset: true }), z.null()]);

const popupFields = {
  name: z.string().trim().min(1, "Name is required").max(120, "Name must be at most 120 characters"),
  priority: intIn("Priority", 0, 1000),
  content: contentSchema,
  design: z.strictObject({ theme: z.enum(POPUP_THEMES), size: z.enum(POPUP_SIZES), imageOnly: z.boolean().optional() }),
  devices: z.strictObject({
    desktop: z.strictObject({ enabled: z.boolean(), placement: z.enum(DESKTOP_PLACEMENTS) }),
    mobile: z.strictObject({ enabled: z.boolean(), placement: z.enum(MOBILE_PLACEMENTS) }),
  }),
  timing: timingSchema,
  display: displaySchema,
  countdown: z.strictObject({
    enabled: z.boolean(),
    endsAt: dateField.optional(),
    label: z.string().trim().max(80, "Countdown headline must be at most 80 characters").optional(),
  }),
  targeting: z.strictObject({ includePaths: z.array(pathField).max(L.maxIncludePaths) }),
  schedule: z.strictObject({ startsAt: dateField.optional(), endsAt: dateField.optional() }),
};

type CrossFieldInput = {
  content?: z.infer<typeof contentSchema>;
  design?: { imageOnly?: boolean };
  timing?: z.infer<typeof timingSchema>;
  display?: z.infer<typeof displaySchema>;
  schedule?: { startsAt?: string | null; endsAt?: string | null };
  countdown?: { enabled: boolean; endsAt?: string | null };
};

// Rules that span fields. Run on whichever of the groups are present, so a
// PATCH that sends `timing` without `display` still gets checked against the
// stored `display` in the service (see mergeAndValidate).
export function crossFieldIssues(input: CrossFieldInput): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const { content, timing, display, schedule, countdown, design } = input;

  if (design?.imageOnly && content && !content.imageUrl && !content.desktopImageUrl && !content.mobileImageUrl) {
    issues.push({ path: ["design", "imageOnly"], message: "Image-only needs an image — add one in Content & Design" });
  }

  if (countdown?.enabled && !countdown.endsAt) {
    issues.push({ path: ["countdown", "endsAt"], message: "Set the countdown end time" });
  }

  if (content) {
    if (Boolean(content.ctaLabel) !== Boolean(content.ctaUrl)) {
      issues.push({
        path: ["content", content.ctaLabel ? "ctaUrl" : "ctaLabel"],
        message: "A call-to-action needs both a button label and a link",
      });
    }
  }

  if (schedule?.startsAt && schedule?.endsAt && new Date(schedule.endsAt) <= new Date(schedule.startsAt)) {
    issues.push({ path: ["schedule", "endsAt"], message: "End time must be after the start time" });
  }

  if (display) {
    if (display.repeatIntervalSeconds > 0 && display.repeatIntervalSeconds < display.minReappearanceSeconds) {
      issues.push({
        path: ["display", "repeatIntervalSeconds"],
        message: "Repeat interval must be at least the minimum reappearance delay",
      });
    }
    if (
      display.dismissalPolicy === "WAIT_INTERVAL" &&
      display.dismissalWaitSeconds < display.minReappearanceSeconds
    ) {
      issues.push({
        path: ["display", "dismissalWaitSeconds"],
        message: "Dismissal wait must be at least the minimum reappearance delay",
      });
    }
  }

  if (timing && display) {
    const sets: [string, z.infer<typeof timingSettingsSchema>][] = [
      ["shared", timing.shared],
      ["desktop", timing.desktop],
      ["mobile", timing.mobile],
    ];
    for (const [key, s] of sets) {
      if (s.autoCloseEnabled && s.autoCloseAfterSeconds > display.maxDisplaySeconds) {
        issues.push({
          path: ["timing", key, "autoCloseAfterSeconds"],
          message: `Auto-close timer cannot exceed the maximum display time (${display.maxDisplaySeconds}s)`,
        });
      }
      if (!display.allowEarlyDismiss) {
        // Locked until the timer fires — so there must BE a short timer.
        if (!s.autoCloseEnabled || s.autoCloseAfterSeconds > L.earlyDismissLockMaxSeconds) {
          issues.push({
            path: ["timing", key, "autoCloseAfterSeconds"],
            message: `Disabling early dismissal requires auto-close of ${L.earlyDismissLockMaxSeconds}s or less, so visitors are never held`,
          });
        }
      }
    }
  }
  return issues;
}

function applyCrossField<T extends CrossFieldInput>(data: T, ctx: z.RefinementCtx) {
  for (const issue of crossFieldIssues(data)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}

// `countdown` is optional on create (defaults to off) so existing clients keep working.
export const createPopupSchema = z
  .strictObject({ ...popupFields, countdown: popupFields.countdown.optional() })
  .superRefine(applyCrossField);

// PATCH: any subset of the top-level groups. Each group is replaced whole
// (no deep-merge), so a group is always internally complete and valid.
// Cross-group rules are re-checked against the merged result in the service.
export const updatePopupSchema = z
  .strictObject(
    Object.fromEntries(
      Object.entries(popupFields).map(([k, v]) => [k, (v as z.ZodType).optional()])
    ) as { [K in keyof typeof popupFields]: z.ZodOptional<(typeof popupFields)[K]> }
  )
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update" });

export const updatePopupStatusSchema = z.strictObject({ status: z.enum(POPUP_STATUSES) });

export const popupEventSchema = z.strictObject({
  type: z.enum(["IMPRESSION", "CLICK", "DISMISS", "AUTO_CLOSE"]),
  device: z.enum(["desktop", "mobile"]),
});

export type CreatePopupInput = z.infer<typeof createPopupSchema>;
export type UpdatePopupInput = z.infer<typeof updatePopupSchema>;
export type PopupEventInput = z.infer<typeof popupEventSchema>;
