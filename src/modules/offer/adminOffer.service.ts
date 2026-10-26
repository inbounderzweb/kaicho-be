import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Category,
  Offer,
  OfferDocument,
  OfferActivity,
  OfferFieldChange,
  OfferUsage,
  Product,
  OFFER_STATUSES,
} from "../../database/models";
import { getMediaDocById, attachMediaToEntity, detachMedia } from "../media/media.service";
import {
  evaluateOfferAgainstLines,
  getEffectiveOfferStatus,
  getOfferMode,
  loadOfferImageMap,
  type OfferCartLine,
} from "./offer.service";
import { getPrimaryImageUrlMap } from "../product/product.service";
import { buildScopeForOffer } from "./offer.service";
import type {
  OfferCreateInput,
  OfferUpdateInput,
  OfferSimulateInput,
} from "./adminOffer.validation";

// Admin-side offer management: CRUD + lifecycle + usage history + audit
// trail + a trusted-price simulator. Customer evaluation / consumption lives
// in offer.service.ts. Everything here is behind requireRole("admin").

const MAX_OFFER_IMAGE_BYTES = 2 * 1024 * 1024;

const isValidObjectId = (id: string) => mongoose.isValidObjectId(id);
const escapeRegex = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oid = (id: string) => new mongoose.Types.ObjectId(id);

function rethrowIfValidation(err: unknown): never {
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    throw new AppError(first?.message ?? "Invalid offer configuration", 400);
  }
  throw err;
}

// The model's pre('validate') hook is the last-line guard, but Mongoose
// surfaces a thrown plain Error from it as a 500. Admin paths assert the same
// rules up-front so the admin gets a 400 with the real reason.
function assertValidOfferConfig(doc: OfferDocument): void {
  if (doc.eligibleProductIds.length === 0) {
    throw new AppError(
      doc.type === "BOGO" ? "Choose at least one product the customer must buy" : "Choose at least one eligible product",
      400
    );
  }
  if (doc.type === "PERCENTAGE") {
    if (!(doc.discountPercent && doc.discountPercent > 0 && doc.discountPercent <= 100)) {
      throw new AppError("Enter a discount percentage between 0 and 100", 400);
    }
  }
  if (doc.type === "FIXED" && !(doc.discountAmount && doc.discountAmount > 0)) {
    throw new AppError("Enter a discount amount greater than 0", 400);
  }
  if (doc.type !== "BOGO" && (doc.freeProductIds?.length ?? 0) > 0) {
    throw new AppError("Free products only apply to Buy X Get Y Free offers", 400);
  }
  if (doc.type !== "BOGO" && (doc.freeProductRules?.length ?? 0) > 0) {
    throw new AppError("Free product rules only apply to Buy X Get Y Free offers", 400);
  }
  const eligible = new Set(doc.eligibleProductIds.map(String));
  const ruleBuyIds = (doc.freeProductRules ?? []).map((r) => String(r.buyProductId));
  if (new Set(ruleBuyIds).size !== ruleBuyIds.length) {
    throw new AppError("Each purchased product can only have one free product rule", 400);
  }
  if (ruleBuyIds.some((b) => !eligible.has(b))) {
    throw new AppError("A free product rule's purchased product must be one of the eligible products", 400);
  }
  const excluded = new Set(doc.excludedProductIds.map(String));
  if ((doc.freeProductRules ?? []).some((r) => r.freeProductIds.some((f) => excluded.has(String(f))))) {
    throw new AppError("A free product can't also be an excluded product", 400);
  }
  if ((doc.freeProductIds ?? []).some((id) => excluded.has(String(id)))) {
    throw new AppError("A free product can't also be an excluded product", 400);
  }
  if (doc.startsAt && doc.endsAt && doc.endsAt.getTime() <= doc.startsAt.getTime()) {
    throw new AppError("End date must be after the start date", 400);
  }
  if (doc.usageLimit != null && doc.usageLimitPerUser != null && doc.usageLimitPerUser > doc.usageLimit) {
    throw new AppError("Per-user usage limit cannot exceed the total usage limit", 400);
  }
}

/**
 * Extra rules for an offer that is (or is about to be) live. Drafts and
 * disabled offers may be saved incomplete; nothing incomplete may be activated.
 */
function assertReadyToActivate(doc: OfferDocument): void {
  assertValidOfferConfig(doc);
  if (doc.type === "BOGO" && (doc.freeProductIds?.length ?? 0) === 0 && (doc.freeProductRules?.length ?? 0) === 0) {
    throw new AppError("Choose the free product(s) before activating a Buy X Get Y Free offer", 409);
  }
}

/** Keeps only the fields that belong to the offer's type, so switching type never leaves stale rules behind. */
function normaliseForType(doc: OfferDocument): void {
  if (doc.type !== "PERCENTAGE") doc.discountPercent = undefined;
  if (doc.type !== "FIXED") doc.discountAmount = undefined;
  if (doc.type !== "BOGO") {
    doc.freeProductIds = [];
    doc.freeProductRules = [];
  }
}

// ---- Referenced-entity validation ----

async function assertIdsExist(model: "Product" | "Category", ids: string[], label: string): Promise<void> {
  if (ids.length === 0) return;
  const count =
    model === "Product"
      ? await Product.countDocuments({ _id: { $in: ids } })
      : await Category.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) throw new AppError(`${label}: one or more selections no longer exist`, 400);
}

async function validateImageMedia(mediaId: string): Promise<void> {
  if (!isValidObjectId(mediaId)) throw new AppError("Invalid media", 400);
  const media = await getMediaDocById(mediaId);
  if (!media) throw new AppError("Media not found", 400);
  if (media.mediaType !== "IMAGE") throw new AppError("Only image media can be used as an offer banner", 400);
  if (media.size > MAX_OFFER_IMAGE_BYTES) throw new AppError("Offer banner must be 2MB or smaller", 400);
}

// ---- Formatting for the audit diff ----

const fmtMoney = (v: number | null | undefined) => (v == null ? "—" : `₹${v}`);
const fmtLimit = (v: number | null | undefined) => (v == null ? "Unlimited" : String(v));
const fmtDate = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 16).replace("T", " ") : "—");
const fmtCount = (ids: unknown[]) => (ids.length === 0 ? "None" : `${ids.length} selected`);

// ---- DTOs ----

function toAdminOfferListItem(doc: OfferDocument) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    type: doc.type,
    buyQuantity: doc.buyQuantity,
    maxFreeUnitsPerOrder: doc.maxFreeUnitsPerOrder,
    minPaidUnitPrice: doc.minPaidUnitPrice ?? 0,
    allowCouponStacking: doc.allowCouponStacking ?? false,
    applyToAll: doc.applyToAll,
    eligibleProductCount: doc.eligibleProductIds.length,
    eligibleCategoryCount: doc.eligibleCategoryIds.length,
    freeProductCount: doc.freeProductIds?.length ?? 0,
    discountPercent: doc.discountPercent ?? null,
    discountAmount: doc.discountAmount ?? null,
    startsAt: doc.startsAt ? doc.startsAt.toISOString() : null,
    endsAt: doc.endsAt ? doc.endsAt.toISOString() : null,
    usageLimit: doc.usageLimit ?? null,
    usageLimitPerUser: doc.usageLimitPerUser ?? null,
    usedCount: doc.usedCount,
    status: doc.status,
    // Stored status folded with the time window — what the badge shows.
    effectiveStatus: getEffectiveOfferStatus(doc),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toActivityDto(doc: {
  _id: mongoose.Types.ObjectId;
  action: string;
  changes: OfferFieldChange[];
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

async function logActivity(params: {
  offerId: mongoose.Types.ObjectId;
  adminId?: string;
  action: "CREATED" | "UPDATED" | "ACTIVATED" | "DISABLED";
  changes?: OfferFieldChange[];
  note?: string;
}): Promise<void> {
  try {
    await OfferActivity.create({
      offerId: params.offerId,
      userId: params.adminId ? oid(params.adminId) : undefined,
      action: params.action,
      changes: params.changes ?? [],
      note: params.note,
    });
  } catch (err) {
    // Best-effort — never fail the real operation because its trail row couldn't be written.
    console.error("Offer activity log failed", {
      offerId: params.offerId.toString(),
      action: params.action,
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

// ---- List ----

const SORTABLE_FIELDS = ["createdAt", "endsAt", "usedCount", "name"] as const;

export interface OfferListParams {
  page: number;
  pageSize: number;
  search?: unknown;
  status?: unknown;
  sort?: unknown;
  order?: unknown;
}

function buildFilter(params: OfferListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (typeof params.search === "string" && params.search.trim()) {
    filter.name = new RegExp(escapeRegex(params.search.trim()), "i");
  }
  if (typeof params.status === "string" && params.status) {
    const now = new Date();
    if (params.status === "EXPIRED") {
      filter.status = "ACTIVE";
      filter.endsAt = { $ne: null, $lte: now };
    } else if (params.status === "SCHEDULED") {
      filter.status = "ACTIVE";
      filter.startsAt = { $ne: null, $gt: now };
    } else if (params.status === "ACTIVE") {
      // Effective ACTIVE = stored ACTIVE and inside the window.
      filter.status = "ACTIVE";
      filter.$and = [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
      ];
    } else if ((OFFER_STATUSES as readonly string[]).includes(params.status)) {
      filter.status = params.status;
    }
  }
  return filter;
}

export async function listOffersAdmin(params: OfferListParams) {
  const field =
    typeof params.sort === "string" && (SORTABLE_FIELDS as readonly string[]).includes(params.sort)
      ? params.sort
      : "createdAt";
  const direction: 1 | -1 = params.order === "asc" ? 1 : -1;
  const filter = buildFilter(params);

  const [docs, total] = await Promise.all([
    Offer.find(filter)
      .sort({ [field]: direction })
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      .exec(),
    Offer.countDocuments(filter),
  ]);

  return { items: docs.map(toAdminOfferListItem), page: params.page, pageSize: params.pageSize, total };
}

// ---- Get one ----

const ACTIVITY_LIMIT = 30;

export async function getOfferAdmin(id: string) {
  if (!isValidObjectId(id)) throw new AppError("Offer not found", 404);
  const doc = await Offer.findById(id).exec();
  if (!doc) throw new AppError("Offer not found", 404);

  const allProductIds = [
    ...doc.eligibleProductIds,
    ...(doc.freeProductIds ?? []),
    ...(doc.freeProductRules ?? []).flatMap((r) => [r.buyProductId, ...r.freeProductIds]),
    ...doc.excludedProductIds,
  ];
  const allCategoryIds = [...doc.eligibleCategoryIds, ...doc.excludedCategoryIds];

  const [activityDocs, products, categories, images, stats, productImages] = await Promise.all([
    OfferActivity.find({ offerId: doc._id })
      .sort({ createdAt: -1 })
      .limit(ACTIVITY_LIMIT)
      .populate("userId", "firstName lastName phone")
      .lean(),
    allProductIds.length
      ? Product.find({ _id: { $in: allProductIds } }).select("name sku pricing.sellingPrice status").lean()
      : [],
    allCategoryIds.length ? Category.find({ _id: { $in: allCategoryIds } }).select("name").lean() : [],
    loadOfferImageMap([doc.imageMediaId]),
    OfferUsage.aggregate<{ _id: null; orders: number; freeUnits: number; discount: number }>([
      { $match: { offerId: doc._id } },
      { $group: { _id: null, orders: { $sum: 1 }, freeUnits: { $sum: "$freeUnits" }, discount: { $sum: "$discountAmount" } } },
    ]),
    allProductIds.length ? getPrimaryImageUrlMap(allProductIds) : new Map<string, string>(),
  ]);

  const productMap = new Map(products.map((p) => [p._id.toString(), p]));
  const categoryMap = new Map(categories.map((c) => [c._id.toString(), c]));
  const productRef = (pid: mongoose.Types.ObjectId) => {
    const p = productMap.get(pid.toString());
    return {
      id: pid.toString(),
      name: p?.name ?? "Deleted product",
      sku: p?.sku ?? null,
      sellingPrice: p?.pricing.sellingPrice ?? null,
      status: p?.status ?? null,
      imageUrl: productImages.get(pid.toString()) ?? null,
    };
  };
  const categoryRef = (cid: mongoose.Types.ObjectId) => ({
    id: cid.toString(),
    name: categoryMap.get(cid.toString())?.name ?? "Deleted category",
  });

  return {
    ...toAdminOfferListItem(doc),
    description: doc.description ?? null,
    image: doc.imageMediaId ? images.get(doc.imageMediaId.toString()) ?? null : null,
    eligibleProducts: doc.eligibleProductIds.map(productRef),
    freeProducts: (doc.freeProductIds ?? []).map(productRef),
    freeProductRules: (doc.freeProductRules ?? []).map((r) => ({
      buyProduct: productRef(r.buyProductId),
      freeProducts: r.freeProductIds.map(productRef),
    })),
    eligibleCategories: doc.eligibleCategoryIds.map(categoryRef),
    excludedProducts: doc.excludedProductIds.map(productRef),
    excludedCategories: doc.excludedCategoryIds.map(categoryRef),
    stats: {
      orders: stats[0]?.orders ?? 0,
      freeUnits: stats[0]?.freeUnits ?? 0,
      totalDiscount: Math.round((stats[0]?.discount ?? 0) * 100) / 100,
    },
    activity: activityDocs.map(toActivityDto),
  };
}

// ---- Create ----

function resolveStoredStatus(
  requested: "DRAFT" | "SCHEDULED" | "ACTIVE" | "DISABLED",
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined
): "DRAFT" | "ACTIVE" | "DISABLED" {
  if (requested === "SCHEDULED") {
    if (!startsAt || startsAt.getTime() <= Date.now()) {
      throw new AppError("A scheduled offer needs a start date in the future", 400);
    }
    return "ACTIVE";
  }
  if (requested === "ACTIVE" && endsAt && endsAt.getTime() <= Date.now()) {
    throw new AppError("This offer's end date has already passed — extend it before activating", 400);
  }
  return requested;
}

export async function createOfferAdmin(input: OfferCreateInput, adminId?: string) {
  const status = resolveStoredStatus(input.status, input.startsAt, input.endsAt);

  await Promise.all([
    assertIdsExist("Product", input.eligibleProductIds, "Eligible products"),
    assertIdsExist("Product", input.freeProductIds, "Free products"),
    assertIdsExist("Product", [...new Set(input.freeProductRules.flatMap((r) => [r.buyProductId, ...r.freeProductIds]))], "Free product rules"),
    assertIdsExist("Category", input.eligibleCategoryIds, "Eligible categories"),
    assertIdsExist("Product", input.excludedProductIds, "Excluded products"),
    assertIdsExist("Category", input.excludedCategoryIds, "Excluded categories"),
    input.imageMediaId ? validateImageMedia(input.imageMediaId) : Promise.resolve(),
  ]);

  let doc: OfferDocument;
  try {
    doc = await Offer.create({
      name: input.name,
      description: input.description || undefined,
      type: input.type,
      imageMediaId: input.imageMediaId || undefined,
      applyToAll: input.applyToAll,
      eligibleProductIds: input.eligibleProductIds,
      eligibleCategoryIds: input.eligibleCategoryIds,
      excludedProductIds: input.excludedProductIds,
      excludedCategoryIds: input.excludedCategoryIds,
      freeProductIds: input.type === "BOGO" ? input.freeProductIds : [],
      freeProductRules:
        input.type === "BOGO"
          ? input.freeProductRules.map((r) => ({ buyProductId: oid(r.buyProductId), freeProductIds: r.freeProductIds.map(oid) }))
          : [],
      discountPercent: input.type === "PERCENTAGE" ? input.discountPercent ?? undefined : undefined,
      discountAmount: input.type === "FIXED" ? input.discountAmount ?? undefined : undefined,
      buyQuantity: input.buyQuantity,
      maxFreeUnitsPerOrder: input.maxFreeUnitsPerOrder,
      minPaidUnitPrice: input.minPaidUnitPrice,
      allowCouponStacking: input.allowCouponStacking,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      usageLimit: input.usageLimit ?? null,
      usageLimitPerUser: input.usageLimitPerUser ?? null,
      status,
      createdBy: adminId ? oid(adminId) : undefined,
    });
  } catch (err) {
    rethrowIfValidation(err);
  }

  if (input.imageMediaId) {
    try {
      await attachMediaToEntity(input.imageMediaId, "OFFER", doc._id.toString(), { field: "image" });
    } catch (err) {
      await doc.deleteOne(); // compensating rollback — no transactions on standalone mongod
      throw err;
    }
  }

  await logActivity({ offerId: doc._id, adminId, action: "CREATED" });
  return getOfferAdmin(doc._id.toString());
}

// ---- Update ----

const TYPE_LABELS: Record<OfferDocument["type"], string> = {
  BOGO: "Buy X Get Y Free",
  PERCENTAGE: "Percentage discount",
  FIXED: "Fixed amount discount",
};

const TRACKED_FIELDS: { label: string; format: (d: OfferDocument) => string }[] = [
  { label: "Title", format: (d) => d.name },
  { label: "Offer type", format: (d) => TYPE_LABELS[d.type] },
  { label: "Discount percentage", format: (d) => (d.discountPercent != null ? `${d.discountPercent}%` : "—") },
  { label: "Discount amount", format: (d) => fmtMoney(d.discountAmount) },
  { label: "Free products", format: (d) => fmtCount(d.freeProductIds ?? []) },
  { label: "Free product rules", format: (d) => fmtCount(d.freeProductRules ?? []) },
  { label: "Description", format: (d) => d.description ?? "—" },
  { label: "Apply to all products", format: (d) => (d.applyToAll ? "Yes" : "No") },
  { label: "Eligible products", format: (d) => fmtCount(d.eligibleProductIds) },
  { label: "Eligible categories", format: (d) => fmtCount(d.eligibleCategoryIds) },
  { label: "Excluded products", format: (d) => fmtCount(d.excludedProductIds) },
  { label: "Excluded categories", format: (d) => fmtCount(d.excludedCategoryIds) },
  { label: "Purchase quantity", format: (d) => String(d.buyQuantity) },
  { label: "Max free units per order", format: (d) => String(d.maxFreeUnitsPerOrder) },
  { label: "Minimum purchased price", format: (d) => fmtMoney(d.minPaidUnitPrice) },
  { label: "Coupon stacking", format: (d) => (d.allowCouponStacking ? "Allowed" : "Not allowed") },
  { label: "Starts", format: (d) => fmtDate(d.startsAt) },
  { label: "Ends", format: (d) => fmtDate(d.endsAt) },
  { label: "Total usage limit", format: (d) => fmtLimit(d.usageLimit) },
  { label: "Per-user limit", format: (d) => fmtLimit(d.usageLimitPerUser) },
  { label: "Banner", format: (d) => (d.imageMediaId ? "Set" : "None") },
];

export async function updateOfferAdmin(id: string, patch: OfferUpdateInput, adminId?: string) {
  if (!isValidObjectId(id)) throw new AppError("Offer not found", 404);
  const doc = await Offer.findById(id).exec();
  if (!doc) throw new AppError("Offer not found", 404);

  await Promise.all([
    patch.eligibleProductIds ? assertIdsExist("Product", patch.eligibleProductIds, "Eligible products") : null,
    patch.freeProductIds ? assertIdsExist("Product", patch.freeProductIds, "Free products") : null,
    patch.freeProductRules
      ? assertIdsExist("Product", [...new Set(patch.freeProductRules.flatMap((r) => [r.buyProductId, ...r.freeProductIds]))], "Free product rules")
      : null,
    patch.eligibleCategoryIds ? assertIdsExist("Category", patch.eligibleCategoryIds, "Eligible categories") : null,
    patch.excludedProductIds ? assertIdsExist("Product", patch.excludedProductIds, "Excluded products") : null,
    patch.excludedCategoryIds ? assertIdsExist("Category", patch.excludedCategoryIds, "Excluded categories") : null,
  ]);

  const before = TRACKED_FIELDS.map((f) => f.format(doc));

  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.type !== undefined) doc.type = patch.type;
  if (patch.freeProductIds !== undefined) doc.freeProductIds = patch.freeProductIds.map(oid);
  if (patch.freeProductRules !== undefined) {
    doc.freeProductRules = patch.freeProductRules.map((r) => ({ buyProductId: oid(r.buyProductId), freeProductIds: r.freeProductIds.map(oid) }));
  }
  if (patch.discountPercent !== undefined) doc.discountPercent = patch.discountPercent ?? undefined;
  if (patch.discountAmount !== undefined) doc.discountAmount = patch.discountAmount ?? undefined;
  if (patch.description !== undefined) doc.description = patch.description || undefined;
  if (patch.applyToAll !== undefined) doc.applyToAll = patch.applyToAll;
  if (patch.eligibleProductIds !== undefined) doc.eligibleProductIds = patch.eligibleProductIds.map(oid);
  if (patch.eligibleCategoryIds !== undefined) doc.eligibleCategoryIds = patch.eligibleCategoryIds.map(oid);
  if (patch.excludedProductIds !== undefined) doc.excludedProductIds = patch.excludedProductIds.map(oid);
  if (patch.excludedCategoryIds !== undefined) doc.excludedCategoryIds = patch.excludedCategoryIds.map(oid);
  if (patch.buyQuantity !== undefined) doc.buyQuantity = patch.buyQuantity;
  if (patch.maxFreeUnitsPerOrder !== undefined) doc.maxFreeUnitsPerOrder = patch.maxFreeUnitsPerOrder;
  if (patch.minPaidUnitPrice !== undefined) doc.minPaidUnitPrice = patch.minPaidUnitPrice;
  if (patch.allowCouponStacking !== undefined) doc.allowCouponStacking = patch.allowCouponStacking;
  if (patch.startsAt !== undefined) doc.startsAt = patch.startsAt ?? null;
  if (patch.endsAt !== undefined) doc.endsAt = patch.endsAt ?? null;
  if (patch.usageLimit !== undefined) doc.usageLimit = patch.usageLimit ?? null;
  if (patch.usageLimitPerUser !== undefined) doc.usageLimitPerUser = patch.usageLimitPerUser ?? null;

  // Fields sent for a type they don't belong to are an error, not silently dropped…
  if (patch.type === undefined || patch.type === doc.type) {
    if (doc.type !== "BOGO" && (patch.freeProductIds?.length ?? 0) > 0) {
      throw new AppError("Free products only apply to Buy X Get Y Free offers", 400);
    }
    if (doc.type !== "BOGO" && (patch.freeProductRules?.length ?? 0) > 0) {
      throw new AppError("Free product rules only apply to Buy X Get Y Free offers", 400);
    }
  }
  // …but leftovers from a previous type are cleared when the type changes.
  if (patch.type !== undefined) {
    if (doc.type !== "BOGO" && patch.freeProductIds === undefined) doc.freeProductIds = [];
    if (doc.type !== "BOGO" && patch.freeProductRules === undefined) doc.freeProductRules = [];
    if (doc.type !== "PERCENTAGE" && patch.discountPercent === undefined) doc.discountPercent = undefined;
    if (doc.type !== "FIXED" && patch.discountAmount === undefined) doc.discountAmount = undefined;
  }
  assertValidOfferConfig(doc);
  // Editing a live offer must leave it live-ready.
  if (doc.status === "ACTIVE") assertReadyToActivate(doc);
  normaliseForType(doc);
  if (doc.usageLimit != null && doc.usageLimit < doc.usedCount) {
    throw new AppError(`Total usage limit can't be below the ${doc.usedCount} redemption(s) already recorded`, 400);
  }

  let previousImageMediaId: string | undefined;
  let nextImageMediaId: string | undefined;
  const imageProvided = patch.imageMediaId !== undefined;
  if (imageProvided) {
    previousImageMediaId = doc.imageMediaId?.toString();
    if (patch.imageMediaId) {
      await validateImageMedia(patch.imageMediaId);
      nextImageMediaId = patch.imageMediaId;
      doc.imageMediaId = oid(patch.imageMediaId);
    } else {
      doc.imageMediaId = undefined;
    }
  }

  if (adminId) doc.updatedBy = oid(adminId);

  try {
    await doc.save();
  } catch (err) {
    rethrowIfValidation(err);
  }

  if (imageProvided && nextImageMediaId !== previousImageMediaId) {
    if (nextImageMediaId) await attachMediaToEntity(nextImageMediaId, "OFFER", id, { field: "image" });
    if (previousImageMediaId) {
      await detachMedia(previousImageMediaId, { entityType: "OFFER", entityId: id, field: "image" });
    }
  }

  const changes: OfferFieldChange[] = [];
  TRACKED_FIELDS.forEach((f, i) => {
    const to = f.format(doc);
    if (before[i] !== to) changes.push({ field: f.label, from: before[i], to });
  });
  if (changes.length > 0) await logActivity({ offerId: doc._id, adminId, action: "UPDATED", changes });

  return getOfferAdmin(id);
}

// ---- Status transitions ----

export async function setOfferStatusAdmin(
  id: string,
  requested: "ACTIVE" | "SCHEDULED" | "DISABLED",
  adminId?: string,
  note?: string
) {
  if (!isValidObjectId(id)) throw new AppError("Offer not found", 404);
  const doc = await Offer.findById(id).exec();
  if (!doc) throw new AppError("Offer not found", 404);

  const next = resolveStoredStatus(requested, doc.startsAt, doc.endsAt);
  if (doc.status === next) return getOfferAdmin(id);

  if (next === "ACTIVE") {
    if (doc.eligibleProductIds.length === 0) {
      throw new AppError("Choose eligible products before activating", 409);
    }
    assertReadyToActivate(doc);
    await Promise.all([
      assertIdsExist("Product", doc.eligibleProductIds.map(String), "Eligible products"),
      assertIdsExist("Product", (doc.freeProductIds ?? []).map(String), "Free products"),
    ]);
  }

  doc.status = next;
  if (adminId) doc.updatedBy = oid(adminId);
  await doc.save();

  await logActivity({ offerId: doc._id, adminId, action: next === "DISABLED" ? "DISABLED" : "ACTIVATED", note });
  return getOfferAdmin(id);
}

// ---- Delete ----

/**
 * Permanently removes an offer. Only a draft or deactivated offer that no
 * order has ever used can go: a live offer must be deactivated first, and
 * once an order redeemed it the offer is history (orders keep their own frozen
 * copy, but the usage trail and reports still point here) — deactivate it instead.
 */
export async function deleteOfferAdmin(id: string): Promise<void> {
  if (!isValidObjectId(id)) throw new AppError("Offer not found", 404);
  const doc = await Offer.findById(id).exec();
  if (!doc) throw new AppError("Offer not found", 404);

  if (doc.status === "ACTIVE") {
    throw new AppError("Deactivate this offer before deleting it", 409);
  }
  const redeemed = doc.usedCount > 0 || (await OfferUsage.exists({ offerId: doc._id }));
  if (redeemed) {
    throw new AppError("This offer has been used on orders, so it can't be deleted. Deactivate it instead.", 409);
  }

  const imageMediaId = doc.imageMediaId?.toString();
  await doc.deleteOne();
  await OfferActivity.deleteMany({ offerId: doc._id });
  if (imageMediaId) {
    await detachMedia(imageMediaId, { entityType: "OFFER", entityId: id, field: "image" }).catch(() => undefined);
  }
}

// ---- Usage history ----

export async function listOfferUsagesAdmin(id: string, { page, pageSize }: { page: number; pageSize: number }) {
  if (!isValidObjectId(id)) throw new AppError("Offer not found", 404);
  const offer = await Offer.findById(id).select("name usedCount").lean();
  if (!offer) throw new AppError("Offer not found", 404);

  const filter = { offerId: oid(id) };
  const [docs, total] = await Promise.all([
    OfferUsage.find(filter)
      .sort({ usedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("userId", "firstName lastName phone")
      .lean(),
    OfferUsage.countDocuments(filter),
  ]);

  return {
    offerName: offer.name,
    totalUsage: offer.usedCount,
    items: docs.map((d) => {
      const u = d.userId as unknown as { firstName?: string; lastName?: string; phone?: string } | null;
      const customer = u && !(u instanceof mongoose.Types.ObjectId)
        ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.phone || "Unknown customer"
        : "Unknown customer";
      return {
        id: d._id.toString(),
        customer,
        orderNumber: d.orderNumber,
        freeUnits: d.freeUnits,
        discountAmount: d.discountAmount,
        usedAt: d.usedAt.toISOString(),
      };
    }),
    page,
    pageSize,
    total,
  };
}

// ---- Simulator ----

/**
 * "Preview" for admins: runs the REAL engine against trusted DB prices for a
 * hypothetical cart, regardless of the offer's status/window, so an admin can
 * see exactly what a customer would get before activating.
 */
export async function simulateOfferAdmin(id: string, input: OfferSimulateInput) {
  if (!isValidObjectId(id)) throw new AppError("Offer not found", 404);
  const doc = await Offer.findById(id).lean();
  if (!doc) throw new AppError("Offer not found", 404);

  const products = await Product.find({ _id: { $in: input.items.map((i) => i.productId) } })
    .select("name sku status categoryId pricing.sellingPrice")
    .lean();
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const lines: OfferCartLine[] = [];
  const skipped: { productId: string; reason: string }[] = [];
  for (const item of input.items) {
    const p = byId.get(item.productId);
    if (!p) skipped.push({ productId: item.productId, reason: "Product not found" });
    else if (p.status !== "ACTIVE") skipped.push({ productId: item.productId, reason: "Product is not active" });
    else
      lines.push({
        productId: item.productId,
        categoryId: p.categoryId.toString(),
        unitPrice: p.pricing.sellingPrice,
        quantity: item.quantity,
      });
  }

  const scope = await buildScopeForOffer(doc);
  const result = evaluateOfferAgainstLines(doc, scope, lines, input.freeSelections);

  return {
    type: doc.type,
    discountAmount: result.discountAmount,
    freeUnits: result.freeUnits,
    limitReached: result.limitReached,
    unitsToNextFree: result.unitsToNextFree,
    needsFreeProduct: result.needsFreeProduct,
    lines: input.items.map((item) => {
      const p = byId.get(item.productId);
      const freeQty = result.freeByProduct.get(item.productId) ?? 0;
      return {
        productId: item.productId,
        name: p?.name ?? null,
        unitPrice: p?.pricing.sellingPrice ?? 0,
        quantity: item.quantity,
        freeQuantity: freeQty,
        paidQuantity: item.quantity - freeQty,
        discountAmount: result.discountByProduct.get(item.productId) ?? 0,
        canBeFree: result.freeCandidateProductIds.includes(item.productId),
      };
    }),
    rejected: result.rejected,
    skipped,
  };
}
