import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Coupon,
  CouponDocument,
  CouponActivity,
  CouponFieldChange,
  CouponUsage,
  COUPON_STATUSES,
  CouponStatus,
} from "../../database/models";
import { canonicalizeCouponCode, getEffectiveCouponStatus } from "./coupon.service";
import type { CouponCreateInput, CouponUpdateInput } from "./adminCoupon.validation";

// Admin-side coupon management. Customer validation / consumption lives in
// coupon.service.ts — this file is CRUD + lifecycle + usage history + the
// audit trail, all behind requireRole("admin").

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

// A Mongoose ValidationError (from the Coupon pre('validate') hook or a
// schema `min`) is a client mistake — surface its message as a 400 rather
// than a 500.
function rethrowIfValidation(err: unknown): never {
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    throw new AppError(first?.message ?? "Invalid coupon configuration", 400);
  }
  throw err;
}

// ---- Formatting for the audit diff ----

function formatMoney(value: number | null | undefined): string {
  return value == null ? "—" : `₹${value}`;
}
function formatLimit(value: number | null | undefined): string {
  return value == null ? "Unlimited" : String(value);
}
function formatDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}
function formatDiscountValue(type: string, value: number): string {
  return type === "PERCENTAGE" ? `${value}%` : type === "FIXED" ? `₹${value}` : "—";
}

// ---- DTOs ----

function toAdminCouponListItem(doc: CouponDocument) {
  return {
    id: doc._id.toString(),
    code: doc.code,
    name: doc.name,
    discountType: doc.discountType,
    discountValue: doc.discountValue,
    maxDiscountAmount: doc.maxDiscountAmount ?? null,
    minOrderValue: doc.minOrderValue,
    startsAt: doc.startsAt ? doc.startsAt.toISOString() : null,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    usageLimit: doc.usageLimit ?? null,
    usageLimitPerUser: doc.usageLimitPerUser ?? null,
    usedCount: doc.usedCount,
    status: doc.status,
    // Stored status folded with the current time window — the badge the
    // listing renders (spec §17).
    effectiveStatus: getEffectiveCouponStatus(doc),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toCouponActivityDto(doc: {
  _id: mongoose.Types.ObjectId;
  action: string;
  changes: CouponFieldChange[];
  note?: string;
  userId?: unknown;
  createdAt: Date;
}) {
  const actor = doc.userId as
    | { firstName?: string; lastName?: string; phone?: string }
    | mongoose.Types.ObjectId
    | null
    | undefined;
  const actorLabel =
    actor && !(actor instanceof mongoose.Types.ObjectId)
      ? [actor.firstName, actor.lastName].filter(Boolean).join(" ").trim() || actor.phone || "Admin"
      : null;
  return {
    id: doc._id.toString(),
    action: doc.action,
    changes: doc.changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
    note: doc.note ?? null,
    actor: actorLabel,
    at: doc.createdAt.toISOString(),
  };
}

function toAdminCouponDetail(
  doc: CouponDocument,
  activity: ReturnType<typeof toCouponActivityDto>[]
) {
  return { ...toAdminCouponListItem(doc), description: doc.description ?? null, activity };
}

// ---- Activity trail ----

async function logActivity(params: {
  couponId: mongoose.Types.ObjectId;
  adminId?: string;
  action: "CREATED" | "UPDATED" | "ACTIVATED" | "PAUSED" | "ARCHIVED";
  changes?: CouponFieldChange[];
  note?: string;
}): Promise<void> {
  try {
    await CouponActivity.create({
      couponId: params.couponId,
      userId: params.adminId ? new mongoose.Types.ObjectId(params.adminId) : undefined,
      action: params.action,
      changes: params.changes ?? [],
      note: params.note,
    });
  } catch (err) {
    // The audit row is best-effort — never fail the actual operation because
    // its trail entry couldn't be written.
    console.error("Coupon activity log failed", {
      couponId: params.couponId.toString(),
      action: params.action,
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

// ---- List ----

const SORTABLE_FIELDS = ["createdAt", "expiresAt", "usedCount", "code"] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

export interface CouponListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  status?: unknown;
  sort?: unknown;
  order?: unknown;
}

function buildCouponFilter(params: CouponListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ code: pattern }, { name: pattern }];
  }

  if (typeof params.status === "string" && params.status) {
    const now = new Date();
    if (params.status === "EXPIRED") {
      filter.status = "ACTIVE";
      filter.expiresAt = { $ne: null, $lt: now };
    } else if (params.status === "SCHEDULED") {
      filter.status = "ACTIVE";
      filter.startsAt = { $ne: null, $gt: now };
    } else if ((COUPON_STATUSES as readonly string[]).includes(params.status)) {
      filter.status = params.status;
    }
  }

  return filter;
}

export async function listCouponsAdmin(params: CouponListParams) {
  const field: SortableField =
    typeof params.sort === "string" && (SORTABLE_FIELDS as readonly string[]).includes(params.sort)
      ? (params.sort as SortableField)
      : "createdAt";
  const direction: 1 | -1 = params.order === "asc" ? 1 : -1;
  const filter = buildCouponFilter(params);

  const [docs, total] = await Promise.all([
    Coupon.find(filter)
      .sort({ [field]: direction })
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      .exec(),
    Coupon.countDocuments(filter),
  ]);

  return {
    items: docs.map(toAdminCouponListItem),
    page: params.page,
    pageSize: params.pageSize,
    total,
  };
}

// ---- Get one ----

const ACTIVITY_LIMIT = 30;

export async function getCouponAdmin(id: string) {
  if (!isValidObjectId(id)) throw new AppError("Coupon not found", 404);
  const doc = await Coupon.findById(id).exec();
  if (!doc) throw new AppError("Coupon not found", 404);

  const activityDocs = await CouponActivity.find({ couponId: doc._id })
    .sort({ createdAt: -1 })
    .limit(ACTIVITY_LIMIT)
    .populate("userId", "firstName lastName phone")
    .lean();

  return toAdminCouponDetail(doc, activityDocs.map(toCouponActivityDto));
}

// ---- Create ----

export async function createCouponAdmin(input: CouponCreateInput, adminId?: string) {
  const code = canonicalizeCouponCode(input.code);

  let doc: CouponDocument;
  try {
    doc = await Coupon.create({
      code,
      name: input.name,
      description: input.description,
      discountType: input.discountType,
      discountValue: input.discountType === "FREE_DELIVERY" ? 0 : input.discountValue,
      maxDiscountAmount: input.discountType === "PERCENTAGE" ? input.maxDiscountAmount ?? null : null,
      minOrderValue: input.minOrderValue ?? 0,
      startsAt: input.startsAt ?? null,
      expiresAt: input.expiresAt ?? null,
      usageLimit: input.usageLimit ?? null,
      usageLimitPerUser: input.usageLimitPerUser ?? null,
      status: input.status,
      createdBy: adminId ? new mongoose.Types.ObjectId(adminId) : undefined,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new AppError("A coupon with this code already exists", 409);
    }
    rethrowIfValidation(err);
  }

  await logActivity({ couponId: doc._id, adminId, action: "CREATED" });
  return getCouponAdmin(doc._id.toString());
}

// ---- Update ----

// Fields the admin form can PATCH, with a formatter for the audit diff.
const TRACKED_FIELDS: {
  key: keyof CouponUpdateInput;
  label: string;
  format: (doc: CouponDocument) => string;
}[] = [
  { key: "code", label: "Code", format: (d) => d.code },
  { key: "name", label: "Name", format: (d) => d.name },
  { key: "description", label: "Description", format: (d) => d.description ?? "—" },
  { key: "discountType", label: "Discount type", format: (d) => d.discountType },
  { key: "discountValue", label: "Discount", format: (d) => formatDiscountValue(d.discountType, d.discountValue) },
  { key: "maxDiscountAmount", label: "Maximum discount", format: (d) => formatMoney(d.maxDiscountAmount) },
  { key: "minOrderValue", label: "Minimum order", format: (d) => formatMoney(d.minOrderValue) },
  { key: "startsAt", label: "Starts", format: (d) => formatDate(d.startsAt) },
  { key: "expiresAt", label: "Expires", format: (d) => formatDate(d.expiresAt) },
  { key: "usageLimit", label: "Total usage limit", format: (d) => formatLimit(d.usageLimit) },
  { key: "usageLimitPerUser", label: "Per-user limit", format: (d) => formatLimit(d.usageLimitPerUser) },
];

export async function updateCouponAdmin(id: string, patch: CouponUpdateInput, adminId?: string) {
  if (!isValidObjectId(id)) throw new AppError("Coupon not found", 404);
  const doc = await Coupon.findById(id).exec();
  if (!doc) throw new AppError("Coupon not found", 404);

  if (doc.status === "ARCHIVED") {
    throw new AppError("This coupon is archived and can no longer be edited", 409);
  }

  // Snapshot the display values before mutating, so the audit diff is exact.
  const before = new Map(TRACKED_FIELDS.map((f) => [f.key, f.format(doc)]));

  if (patch.code !== undefined) {
    const nextCode = canonicalizeCouponCode(patch.code);
    if (nextCode !== doc.code && doc.usedCount > 0) {
      throw new AppError(
        "This coupon has already been redeemed — its code can't be changed. Archive it and create a new one instead.",
        409
      );
    }
    doc.code = nextCode;
  }
  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.description !== undefined) doc.description = patch.description || undefined;
  if (patch.discountType !== undefined) doc.discountType = patch.discountType;
  if (patch.discountValue !== undefined) doc.discountValue = patch.discountValue;
  if (patch.maxDiscountAmount !== undefined) doc.maxDiscountAmount = patch.maxDiscountAmount ?? null;
  if (patch.minOrderValue !== undefined) doc.minOrderValue = patch.minOrderValue;
  if (patch.startsAt !== undefined) doc.startsAt = patch.startsAt ?? null;
  if (patch.expiresAt !== undefined) doc.expiresAt = patch.expiresAt ?? null;
  if (patch.usageLimit !== undefined) doc.usageLimit = patch.usageLimit ?? null;
  if (patch.usageLimitPerUser !== undefined) doc.usageLimitPerUser = patch.usageLimitPerUser ?? null;

  // A discount that's no longer a percentage can't keep a percentage cap.
  if (doc.discountType !== "PERCENTAGE") doc.maxDiscountAmount = null;
  if (doc.discountType === "FREE_DELIVERY") doc.discountValue = 0;

  if (doc.usageLimit != null && doc.usageLimit < doc.usedCount) {
    throw new AppError(
      `Total usage limit can't be below the ${doc.usedCount} redemption(s) already recorded`,
      400
    );
  }

  doc.updatedBy = adminId ? new mongoose.Types.ObjectId(adminId) : doc.updatedBy;

  try {
    await doc.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError("A coupon with this code already exists", 409);
    rethrowIfValidation(err);
  }

  const changes: CouponFieldChange[] = [];
  for (const f of TRACKED_FIELDS) {
    const from = before.get(f.key) ?? "—";
    const to = f.format(doc);
    if (from !== to) changes.push({ field: f.label, from, to });
  }
  if (changes.length > 0) {
    await logActivity({ couponId: doc._id, adminId, action: "UPDATED", changes });
  }

  return getCouponAdmin(id);
}

// ---- Status transitions ----

const STATUS_TRANSITIONS: Record<CouponStatus, CouponStatus[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

const STATUS_ACTION: Record<"ACTIVE" | "PAUSED" | "ARCHIVED", "ACTIVATED" | "PAUSED" | "ARCHIVED"> = {
  ACTIVE: "ACTIVATED",
  PAUSED: "PAUSED",
  ARCHIVED: "ARCHIVED",
};

export async function setCouponStatusAdmin(
  id: string,
  status: "ACTIVE" | "PAUSED" | "ARCHIVED",
  adminId?: string,
  note?: string
) {
  if (!isValidObjectId(id)) throw new AppError("Coupon not found", 404);
  const doc = await Coupon.findById(id).exec();
  if (!doc) throw new AppError("Coupon not found", 404);

  if (doc.status === status) {
    return getCouponAdmin(id);
  }
  if (!STATUS_TRANSITIONS[doc.status].includes(status)) {
    throw new AppError(
      `Can't move a ${doc.status.toLowerCase()} coupon to ${status.toLowerCase()}`,
      409
    );
  }

  doc.status = status;
  doc.updatedBy = adminId ? new mongoose.Types.ObjectId(adminId) : doc.updatedBy;
  await doc.save();

  await logActivity({ couponId: doc._id, adminId, action: STATUS_ACTION[status], note });
  return getCouponAdmin(id);
}

// ---- Usage history ----

interface PopulatedUsageUser {
  _id: mongoose.Types.ObjectId;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

function usageCustomerLabel(userId: unknown): string {
  if (!userId || userId instanceof mongoose.Types.ObjectId) return "Unknown customer";
  const u = userId as PopulatedUsageUser;
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.phone || "Unknown customer";
}

export async function listCouponUsagesAdmin(
  id: string,
  { page, pageSize }: { page: number; pageSize: number }
) {
  if (!isValidObjectId(id)) throw new AppError("Coupon not found", 404);
  const coupon = await Coupon.findById(id).select("code usedCount").lean();
  if (!coupon) throw new AppError("Coupon not found", 404);

  const filter = { couponId: new mongoose.Types.ObjectId(id) };
  const [docs, total] = await Promise.all([
    CouponUsage.find(filter)
      .sort({ usedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("userId", "firstName lastName phone")
      .lean(),
    CouponUsage.countDocuments(filter),
  ]);

  return {
    couponCode: coupon.code,
    totalUsage: coupon.usedCount,
    items: docs.map((d) => ({
      id: d._id.toString(),
      customer: usageCustomerLabel(d.userId),
      orderNumber: d.orderNumber,
      discountAmount: d.discountAmount,
      freeDelivery: d.freeDelivery,
      usedAt: d.usedAt.toISOString(),
    })),
    page,
    pageSize,
    total,
  };
}
