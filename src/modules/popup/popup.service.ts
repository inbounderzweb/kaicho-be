import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Offer, Popup, PopupDocument, PopupStatus, POPUP_STATUSES } from "../../database/models";
import { getEffectiveOfferStatus } from "../offer/offer.service";
import { crossFieldIssues } from "./popup.validation";
import type { CreatePopupInput, UpdatePopupInput, PopupEventInput } from "./popup.validation";

// Controller → service → model. Every business rule (cross-field validation,
// publish readiness, what counts as "live") lives here.

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOT_FOUND = "Popup not found";

// ---- Effective state (derived, never stored) ----

export type PopupEffectiveState = "DRAFT" | "PAUSED" | "ARCHIVED" | "SCHEDULED" | "LIVE" | "EXPIRED";

export function getEffectivePopupState(
  doc: Pick<PopupDocument, "status" | "schedule">,
  now: Date = new Date()
): PopupEffectiveState {
  if (doc.status !== "PUBLISHED") return doc.status;
  const { startsAt, endsAt } = doc.schedule ?? {};
  if (startsAt && startsAt > now) return "SCHEDULED";
  if (endsAt && endsAt <= now) return "EXPIRED";
  return "LIVE";
}

// The DB-side equivalent of getEffectivePopupState === "LIVE". Used by the
// public listing AND by the event endpoint so neither can disagree with the
// derived state shown in the admin.
function liveFilter(now: Date) {
  return {
    status: "PUBLISHED" as const,
    $and: [
      { $or: [{ "schedule.startsAt": null }, { "schedule.startsAt": { $lte: now } }] },
      { $or: [{ "schedule.endsAt": null }, { "schedule.endsAt": { $gt: now } }] },
    ],
  };
}

// ---- DTOs ----

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function configOf(doc: PopupDocument) {
  const o = doc.toObject({ depopulate: true });
  return plain({
    content: {
      heading: o.content.heading ?? "",
      body: o.content.body ?? "",
      imageUrl: o.content.imageUrl ?? undefined,
      desktopImageUrl: o.content.desktopImageUrl ?? undefined,
      mobileImageUrl: o.content.mobileImageUrl ?? undefined,
      imageAlt: o.content.imageAlt ?? undefined,
      ctaLabel: o.content.ctaLabel ?? undefined,
      ctaUrl: o.content.ctaUrl ?? undefined,
    },
    design: o.design,
    devices: o.devices,
    timing: o.timing,
    display: o.display,
    countdown: {
      enabled: Boolean(o.countdown?.enabled),
      endsAt: o.countdown?.endsAt ? new Date(o.countdown.endsAt).toISOString() : null,
      label: o.countdown?.label || undefined,
      position: o.countdown?.position ?? "BOTTOM_CENTER",
    },
    targeting: o.targeting,
  });
}

// The offers a popup follows: the list, or the single legacy link.
export function linkedOfferIds(doc: Pick<PopupDocument, "offerIds" | "offerId">): string[] {
  const ids = (doc.offerIds ?? []).map((id) => id.toString());
  if (ids.length === 0 && doc.offerId) ids.push(doc.offerId.toString());
  return ids;
}

export function toPopupDto(doc: PopupDocument, now: Date = new Date()) {
  const o = doc.toObject({ depopulate: true });
  return {
    id: doc._id.toString(),
    name: doc.name,
    status: doc.status,
    effectiveState: getEffectivePopupState(doc, now),
    priority: doc.priority,
    offerIds: linkedOfferIds(doc),
    ...configOf(doc),
    schedule: {
      startsAt: doc.schedule?.startsAt ? doc.schedule.startsAt.toISOString() : null,
      endsAt: doc.schedule?.endsAt ? doc.schedule.endsAt.toISOString() : null,
    },
    analytics: plain(o.analytics),
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export type PopupDto = ReturnType<typeof toPopupDto>;

// What the storefront receives: the runtime config only. No name, analytics,
// schedule or author ids. `revision` changes whenever the admin edits the
// popup, which is how the storefront knows to restart its timers.
export function toPublicPopupDto(doc: PopupDocument) {
  return { id: doc._id.toString(), revision: doc.updatedAt.toISOString(), linkedToOffer: false, ...configOf(doc) };
}

export type PublicPopupDto = ReturnType<typeof toPublicPopupDto>;

// ---- List ----

export interface ListPopupsParams {
  page: number;
  pageSize: number;
  search?: unknown;
  status?: unknown;
}

export async function listPopups(params: ListPopupsParams) {
  const filter: Record<string, unknown> = {};
  if (typeof params.status === "string" && (POPUP_STATUSES as readonly string[]).includes(params.status)) {
    filter.status = params.status;
  } else {
    filter.status = { $ne: "ARCHIVED" };
  }
  if (typeof params.search === "string" && params.search.trim()) {
    filter.name = new RegExp(escapeRegex(params.search.trim()), "i");
  }

  const now = new Date();
  const [docs, total] = await Promise.all([
    Popup.find(filter)
      .sort({ priority: 1, createdAt: -1 })
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      .exec(),
    Popup.countDocuments(filter),
  ]);
  return {
    items: docs.map((d) => toPopupDto(d, now)),
    page: params.page,
    pageSize: params.pageSize,
    total,
  };
}

// ---- Get ----

async function findOrThrow(id: string): Promise<PopupDocument> {
  if (!isValidObjectId(id)) throw new AppError(NOT_FOUND, 404);
  const doc = await Popup.findById(id).exec();
  if (!doc) throw new AppError(NOT_FOUND, 404);
  return doc;
}

export async function getPopupById(id: string): Promise<PopupDto> {
  return toPopupDto(await findOrThrow(id));
}

// ---- Create / update ----

function toDate(value: string | null | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function adminObjectId(adminId?: string) {
  return adminId ? new mongoose.Types.ObjectId(adminId) : undefined;
}

async function assertOffersExist(offerIds: string[] | undefined): Promise<void> {
  if (!offerIds || offerIds.length === 0) return;
  const found = await Offer.countDocuments({ _id: { $in: offerIds } });
  if (found !== offerIds.length) throw new AppError("One of the selected offers no longer exists", 400);
}

export async function createPopup(input: CreatePopupInput, adminId?: string): Promise<PopupDto> {
  await assertOffersExist(input.offerIds);
  const doc = await Popup.create({
    ...input,
    offerIds: input.offerIds ?? [],
    offerId: null,
    // New popups are always drafts; going live is an explicit status change.
    status: "DRAFT",
    schedule: { startsAt: toDate(input.schedule.startsAt), endsAt: toDate(input.schedule.endsAt) },
    countdown: {
      enabled: input.countdown?.enabled ?? false,
      endsAt: toDate(input.countdown?.endsAt),
      label: input.countdown?.label || undefined,
      position: input.countdown?.position ?? "BOTTOM_CENTER",
    },
    createdBy: adminObjectId(adminId),
  });
  return toPopupDto(doc);
}

export async function updatePopup(id: string, patch: UpdatePopupInput, adminId?: string): Promise<PopupDto> {
  const doc = await findOrThrow(id);
  if (doc.status === "ARCHIVED") throw new AppError("Restore this popup before editing it", 409);

  // PATCH replaces whole groups; cross-group rules are checked against what
  // the document WILL look like, so `timing` alone can't violate `display`.
  const merged = {
    content: patch.content ?? configOf(doc).content,
    design: patch.design ?? configOf(doc).design,
    timing: patch.timing ?? configOf(doc).timing,
    display: patch.display ?? configOf(doc).display,
    countdown: patch.countdown ?? configOf(doc).countdown,
    offerIds: patch.offerIds !== undefined ? patch.offerIds : linkedOfferIds(doc),
    schedule: patch.schedule
      ? { startsAt: patch.schedule.startsAt ?? null, endsAt: patch.schedule.endsAt ?? null }
      : {
          startsAt: doc.schedule?.startsAt?.toISOString() ?? null,
          endsAt: doc.schedule?.endsAt?.toISOString() ?? null,
        },
  };
  const issues = crossFieldIssues(merged as Parameters<typeof crossFieldIssues>[0]);
  if (issues.length) throw new AppError(issues.map((i) => i.message).join(", "), 400);

  if (patch.offerIds !== undefined) {
    await assertOffersExist(patch.offerIds);
    doc.offerIds = patch.offerIds.map((id) => new mongoose.Types.ObjectId(id));
    doc.offerId = null; // the list replaces the old single link
  }
  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.priority !== undefined) doc.priority = patch.priority;
  if (patch.content) doc.set("content", patch.content);
  if (patch.design) doc.set("design", patch.design);
  if (patch.devices) doc.set("devices", patch.devices);
  if (patch.timing) doc.set("timing", patch.timing);
  if (patch.display) doc.set("display", patch.display);
  if (patch.countdown) {
    doc.set("countdown", {
      enabled: patch.countdown.enabled,
      endsAt: toDate(patch.countdown.endsAt),
      label: patch.countdown.label || undefined,
      position: patch.countdown.position ?? "BOTTOM_CENTER",
    });
  }
  if (patch.targeting) doc.set("targeting", patch.targeting);
  if (patch.schedule) {
    doc.set("schedule", {
      startsAt: toDate(patch.schedule.startsAt),
      endsAt: toDate(patch.schedule.endsAt),
    });
  }

  // A live popup must stay publishable after every edit.
  if (doc.status === "PUBLISHED") assertPublishable(doc);

  doc.updatedBy = adminObjectId(adminId) ?? doc.updatedBy;
  await doc.save();
  return toPopupDto(doc);
}

// ---- Status ----

function assertPublishable(doc: PopupDocument): void {
  if (!doc.content.heading?.trim() && !doc.content.body?.trim() && !doc.content.imageUrl && !doc.content.desktopImageUrl && !doc.content.mobileImageUrl) {
    throw new AppError("Add an image, heading or body text before publishing", 400);
  }
  if (!doc.devices.desktop.enabled && !doc.devices.mobile.enabled) {
    throw new AppError("Enable the popup on at least one device before publishing", 400);
  }
  const { startsAt, endsAt } = doc.schedule ?? {};
  if (endsAt && endsAt <= new Date() && !(startsAt && startsAt > new Date())) {
    throw new AppError("The schedule has already ended — change the end time before publishing", 400);
  }
}

export async function setPopupStatus(id: string, status: PopupStatus, adminId?: string): Promise<PopupDto> {
  const doc = await findOrThrow(id);
  if (status === "PUBLISHED") {
    assertPublishable(doc);
    if (doc.status !== "PUBLISHED") doc.publishedAt = new Date();
  }
  doc.status = status;
  doc.updatedBy = adminObjectId(adminId) ?? doc.updatedBy;
  await doc.save();
  return toPopupDto(doc);
}

// Soft delete, same as Instagram posts / YouTube videos. Idempotent.
export async function archivePopup(id: string, adminId?: string): Promise<PopupDto> {
  return setPopupStatus(id, "ARCHIVED", adminId);
}

// ---- Public ----

export async function listLivePopups(now: Date = new Date()): Promise<PublicPopupDto[]> {
  const docs = await Popup.find(liveFilter(now))
    .sort({ priority: 1, createdAt: -1 })
    .limit(25) // headroom: linked popups whose offer isn't live are dropped below
    .exec();

  // Popups linked to offers follow them: shown while at least one linked offer
  // is live, hidden when none is (ended, disabled, not started, deleted). The
  // countdown runs to the soonest end among the LIVE linked offers. One query
  // covers every linked popup.
  const allOfferIds = [...new Set(docs.flatMap((d) => linkedOfferIds(d)))];
  const offers = allOfferIds.length
    ? await Offer.find({ _id: { $in: allOfferIds } }).select("status startsAt endsAt updatedAt").lean()
    : [];
  const offerById = new Map(offers.map((o) => [o._id.toString(), o]));

  const result: PublicPopupDto[] = [];
  for (const doc of docs) {
    const ids = linkedOfferIds(doc);
    if (ids.length === 0) {
      result.push(toPublicPopupDto(doc));
      continue;
    }
    const linked = ids.map((id) => offerById.get(id)).filter((o): o is NonNullable<typeof o> => Boolean(o));
    const live = linked.filter((o) => getEffectiveOfferStatus(o, now) === "ACTIVE");
    if (live.length === 0) continue;

    const dto = toPublicPopupDto(doc);
    // Soonest end among live offers that have one. Offers with no end date
    // keep the popup alive but give the timer nothing to count to.
    const ends = live.filter((o) => o.endsAt).map((o) => new Date(o.endsAt as Date).getTime());
    const nextEnd = ends.length ? new Date(Math.min(...ends)).toISOString() : null;
    // The revision moves when the popup OR any linked offer changed, so open
    // storefronts pick up an edited end time.
    const revision = new Date(
      Math.max(doc.updatedAt.getTime(), ...linked.map((o) => new Date(o.updatedAt).getTime()))
    ).toISOString();
    result.push({
      ...dto,
      revision,
      linkedToOffer: true,
      countdown: { ...dto.countdown, enabled: dto.countdown.enabled && nextEnd !== null, endsAt: nextEnd },
    });
  }
  return result.slice(0, 5);
}

const EVENT_FIELD = {
  IMPRESSION: "impressions",
  CLICK: "clicks",
  DISMISS: "manualCloses",
  AUTO_CLOSE: "autoCloses",
} as const;

// Counts one storefront event. Returns false (and counts nothing) when the
// popup isn't live right now — a paused / expired / draft popup can't
// accumulate production analytics even if a stale tab keeps reporting.
export async function recordPopupEvent(id: string, event: PopupEventInput): Promise<boolean> {
  if (!isValidObjectId(id)) return false;
  const field = `analytics.${event.device}.${EVENT_FIELD[event.type]}`;
  const res = await Popup.updateOne(
    { _id: id, ...liveFilter(new Date()) },
    { $inc: { [field]: 1 } },
    { timestamps: false }
  ).exec();
  return res.modifiedCount > 0;
}
