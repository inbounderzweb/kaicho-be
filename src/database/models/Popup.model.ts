import { Schema, model, Document, Types } from "mongoose";

// A storefront marketing popup. ONE document holds the campaign: content,
// design, per-device behaviour, timing/dismissal rules, schedule and
// aggregate analytics counters.
//
// Every timing / dismissal knob is an explicit, typed, bounded field — never
// a free-form config blob — so the same shape can be validated identically on
// the server (popup.validation.ts), in the admin form, and defensively again
// by the storefront runtime. The bounds live in popup.limits.ts.
//
// "Scheduled" and "Expired" are DERIVED from `schedule` + now (see
// getEffectivePopupState in popup.service.ts) — never stored — so they can't
// drift from reality, the same rule Coupon follows for EXPIRED.

export const POPUP_STATUSES = ["DRAFT", "PUBLISHED", "PAUSED", "ARCHIVED"] as const;
export type PopupStatus = (typeof POPUP_STATUSES)[number];

export const POPUP_THEMES = ["LIGHT", "DARK", "BRAND"] as const;
export type PopupTheme = (typeof POPUP_THEMES)[number];

export const POPUP_SIZES = ["SM", "MD", "LG"] as const;
export type PopupSize = (typeof POPUP_SIZES)[number];

export const DESKTOP_PLACEMENTS = ["CENTER", "BOTTOM_RIGHT", "BOTTOM_LEFT"] as const;
export type DesktopPlacement = (typeof DESKTOP_PLACEMENTS)[number];

export const MOBILE_PLACEMENTS = ["CENTER", "BOTTOM_SHEET"] as const;
export type MobilePlacement = (typeof MOBILE_PLACEMENTS)[number];

export const CLOSE_BUTTON_POSITIONS = ["TOP_RIGHT", "TOP_LEFT"] as const;
export type CloseButtonPosition = (typeof CLOSE_BUTTON_POSITIONS)[number];

export const CLOSE_BUTTON_SIZES = ["SM", "MD", "LG"] as const;
export type CloseButtonSize = (typeof CLOSE_BUTTON_SIZES)[number];

export const CLOSE_BUTTON_STYLES = ["SUBTLE", "SOLID", "OUTLINED"] as const;
export type CloseButtonStyle = (typeof CLOSE_BUTTON_STYLES)[number];

// What a manual dismissal means for the NEXT appearance:
//  SESSION_SUPPRESS — never again this browser session.
//  WAIT_INTERVAL    — not again until `dismissalWaitSeconds` have passed
//                     (persisted across sessions).
//  FOLLOW_FREQUENCY — just the normal session limit / repeat / min-gap rules.
export const DISMISSAL_POLICIES = ["SESSION_SUPPRESS", "WAIT_INTERVAL", "FOLLOW_FREQUENCY"] as const;
export type DismissalPolicy = (typeof DISMISSAL_POLICIES)[number];

export interface PopupTimingSettings {
  initialDelaySeconds: number;
  autoCloseEnabled: boolean;
  autoCloseAfterSeconds: number;
  countdownVisible: boolean;
  closeButtonEnabled: boolean;
  closeButtonPosition: CloseButtonPosition;
  backdropDismissEnabled: boolean;
  escapeDismissEnabled: boolean;
}

export interface PopupDeviceAnalytics {
  impressions: number;
  clicks: number;
  manualCloses: number;
  autoCloses: number;
}

export interface PopupDocument extends Document {
  name: string;
  status: PopupStatus;
  priority: number;
  content: {
    heading: string;
    body: string;
    imageUrl?: string;
    imageAlt?: string;
    ctaLabel?: string;
    ctaUrl?: string;
  };
  design: { theme: PopupTheme; size: PopupSize };
  devices: {
    desktop: { enabled: boolean; placement: DesktopPlacement };
    mobile: { enabled: boolean; placement: MobilePlacement };
  };
  timing: {
    useSharedTimingSettings: boolean;
    shared: PopupTimingSettings;
    desktop: PopupTimingSettings;
    mobile: PopupTimingSettings;
  };
  display: {
    maxDisplaySeconds: number;
    allowEarlyDismiss: boolean;
    closeButtonSize: CloseButtonSize;
    closeButtonStyle: CloseButtonStyle;
    dismissalPolicy: DismissalPolicy;
    dismissalWaitSeconds: number;
    sessionDisplayLimit: number;
    repeatIntervalSeconds: number;
    minReappearanceSeconds: number;
  };
  // Optional urgency timer (days/hours/min/sec to `endsAt`) shown inside the
  // popup. Independent of the auto-close timer and of `schedule`.
  countdown: { enabled: boolean; endsAt?: Date; label?: string };
  targeting: { includePaths: string[] };
  schedule: { startsAt?: Date; endsAt?: Date };
  analytics: { desktop: PopupDeviceAnalytics; mobile: PopupDeviceAnalytics };
  publishedAt?: Date;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const timingSettingsSchema = new Schema<PopupTimingSettings>(
  {
    initialDelaySeconds: { type: Number, required: true, default: 3, min: 0, max: 300 },
    autoCloseEnabled: { type: Boolean, required: true, default: true },
    autoCloseAfterSeconds: { type: Number, required: true, default: 10, min: 3, max: 300 },
    countdownVisible: { type: Boolean, required: true, default: false },
    closeButtonEnabled: { type: Boolean, required: true, default: true },
    closeButtonPosition: { type: String, enum: CLOSE_BUTTON_POSITIONS, required: true, default: "TOP_RIGHT" },
    backdropDismissEnabled: { type: Boolean, required: true, default: true },
    escapeDismissEnabled: { type: Boolean, required: true, default: true },
  },
  { _id: false }
);

const deviceAnalyticsSchema = new Schema<PopupDeviceAnalytics>(
  {
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    manualCloses: { type: Number, default: 0, min: 0 },
    autoCloses: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const PopupSchema = new Schema<PopupDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: POPUP_STATUSES, required: true, default: "DRAFT" },
    priority: { type: Number, required: true, default: 100, min: 0, max: 1000 },
    content: {
      heading: { type: String, trim: true, maxlength: 120, default: "" },
      body: { type: String, trim: true, maxlength: 500, default: "" },
      imageUrl: { type: String, trim: true, maxlength: 2048 },
      imageAlt: { type: String, trim: true, maxlength: 200 },
      ctaLabel: { type: String, trim: true, maxlength: 40 },
      ctaUrl: { type: String, trim: true, maxlength: 2048 },
    },
    design: {
      theme: { type: String, enum: POPUP_THEMES, required: true, default: "LIGHT" },
      size: { type: String, enum: POPUP_SIZES, required: true, default: "MD" },
    },
    devices: {
      desktop: {
        enabled: { type: Boolean, required: true, default: true },
        placement: { type: String, enum: DESKTOP_PLACEMENTS, required: true, default: "CENTER" },
      },
      mobile: {
        enabled: { type: Boolean, required: true, default: true },
        placement: { type: String, enum: MOBILE_PLACEMENTS, required: true, default: "BOTTOM_SHEET" },
      },
    },
    timing: {
      useSharedTimingSettings: { type: Boolean, required: true, default: true },
      shared: { type: timingSettingsSchema, required: true, default: () => ({}) },
      desktop: { type: timingSettingsSchema, required: true, default: () => ({}) },
      mobile: { type: timingSettingsSchema, required: true, default: () => ({}) },
    },
    display: {
      maxDisplaySeconds: { type: Number, required: true, default: 60, min: 5, max: 600 },
      allowEarlyDismiss: { type: Boolean, required: true, default: true },
      closeButtonSize: { type: String, enum: CLOSE_BUTTON_SIZES, required: true, default: "MD" },
      closeButtonStyle: { type: String, enum: CLOSE_BUTTON_STYLES, required: true, default: "SOLID" },
      dismissalPolicy: { type: String, enum: DISMISSAL_POLICIES, required: true, default: "SESSION_SUPPRESS" },
      dismissalWaitSeconds: { type: Number, required: true, default: 86400, min: 60, max: 2_592_000 },
      sessionDisplayLimit: { type: Number, required: true, default: 1, min: 1, max: 10 },
      repeatIntervalSeconds: { type: Number, required: true, default: 0, min: 0, max: 86400 },
      minReappearanceSeconds: { type: Number, required: true, default: 30, min: 5, max: 86400 },
    },
    countdown: {
      enabled: { type: Boolean, required: true, default: false },
      endsAt: { type: Date },
      label: { type: String, trim: true, maxlength: 80 },
    },
    targeting: {
      includePaths: { type: [String], default: [] },
    },
    schedule: {
      startsAt: { type: Date },
      endsAt: { type: Date },
    },
    analytics: {
      desktop: { type: deviceAnalyticsSchema, default: () => ({}) },
      mobile: { type: deviceAnalyticsSchema, default: () => ({}) },
    },
    publishedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Public query: status=PUBLISHED, ordered by priority. Admin list sorts the
// same way, so one composite index serves both.
PopupSchema.index({ status: 1, priority: 1 });

export const Popup = model<PopupDocument>("Popup", PopupSchema);
