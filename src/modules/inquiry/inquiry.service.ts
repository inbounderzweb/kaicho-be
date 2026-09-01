import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Inquiry,
  InquiryDocument,
  InquiryNote,
  InquiryActivity,
  User,
  INQUIRY_STATUSES,
  type InquiryFormType,
  type InquiryStatus,
  type InquiryAction,
} from "../../database/models";
import { createInquiryWithUniqueNumber } from "./inquiry.number";
import { toE164IndianMobile } from "../../common/utils/phone";
import type {
  SubmitBulkOrderInput,
  SubmitContactInput,
  UpdateInquiryInput,
} from "./inquiry.validation";

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lightweight admin-action log — same console-shipping shape as
// media/mediaLogger.ts. The per-inquiry audit trail lives in InquiryActivity;
// this is the broader "who did what" stream for ops visibility (spec §13).
function logInquiryEvent(event: string, meta: Record<string, unknown>): void {
  console.info(`[inquiry] ${event}`, JSON.stringify(meta));
}

async function writeActivity(
  inquiryId: mongoose.Types.ObjectId | string,
  action: InquiryAction,
  opts: { userId?: string | null; oldValue?: string; newValue?: string } = {}
): Promise<void> {
  await InquiryActivity.create({
    inquiryId,
    userId: opts.userId ? new mongoose.Types.ObjectId(opts.userId) : undefined,
    action,
    oldValue: opts.oldValue,
    newValue: opts.newValue,
  });
}

async function userDisplayName(userId: mongoose.Types.ObjectId | string | null | undefined): Promise<string> {
  if (!userId) return "Unassigned";
  const user = await User.findById(userId).select("firstName lastName phone").lean();
  if (!user) return "Unknown user";
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.phone || "Unknown user";
}

// ---------------------------------------------------------------------------
// Public: form submission
// ---------------------------------------------------------------------------

export async function createInquiryFromForm(
  formType: InquiryFormType,
  input: SubmitBulkOrderInput | SubmitContactInput
): Promise<{ inquiryNumber: string }> {
  // Defence in depth beyond the route's zod schema — the per-formType required
  // set, enforced here so it holds even if a caller wired the wrong schema.
  if (formType === "bulk_order") {
    const b = input as SubmitBulkOrderInput;
    if (!b.phone || !b.quantity || !b.purpose) {
      throw new AppError("Missing required bulk-order fields", 400);
    }
  } else if (formType === "contact") {
    const c = input as SubmitContactInput;
    if (!c.message || !c.message.trim()) throw new AppError("Message is required", 400);
  }

  const doc = await createInquiryWithUniqueNumber({
    formType,
    name: input.name.trim(),
    email: input.email.trim(),
    // Store a canonical "+91XXXXXXXXXX"; falls back to the trimmed input only
    // for a contact inquiry that legitimately has no phone.
    phone: input.phone ? toE164IndianMobile(input.phone) ?? input.phone.trim() : undefined,
    quantity: formType === "bulk_order" ? (input as SubmitBulkOrderInput).quantity : undefined,
    purpose:
      formType === "bulk_order" ? (input as SubmitBulkOrderInput).purpose.trim() : undefined,
    message: input.message?.trim() || undefined,
    status: "NEW",
  });

  await writeActivity(doc._id, "CREATED", { userId: null, newValue: "NEW" });
  logInquiryEvent("submitted", { inquiryNumber: doc.inquiryNumber, formType });

  return { inquiryNumber: doc.inquiryNumber };
}

// ---------------------------------------------------------------------------
// Admin: list / detail
// ---------------------------------------------------------------------------

const LIST_SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  updated: { updatedAt: -1 },
  name: { name: 1 },
};

function shapeListItem(doc: InquiryDocument, assigneeName: string | null) {
  return {
    inquiryId: doc._id.toString(),
    inquiryNumber: doc.inquiryNumber,
    formType: doc.formType,
    name: doc.name,
    email: doc.email,
    phone: doc.phone ?? null,
    quantity: doc.quantity ?? null,
    purpose: doc.purpose ?? null,
    status: doc.status,
    assignedTo: doc.assignedTo
      ? { userId: doc.assignedTo.toString(), name: assigneeName ?? "Unknown user" }
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function listInquiriesAdmin(params: {
  page: number;
  pageSize: number;
  formType?: unknown;
  status?: unknown;
  assignedTo?: unknown;
  search?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  sort?: unknown;
}) {
  const filter: Record<string, unknown> = {};

  if (params.formType === "bulk_order" || params.formType === "contact") {
    filter.formType = params.formType;
  }
  if (typeof params.status === "string" && (INQUIRY_STATUSES as readonly string[]).includes(params.status)) {
    filter.status = params.status;
  }
  if (typeof params.assignedTo === "string" && params.assignedTo) {
    if (params.assignedTo === "unassigned") filter.assignedTo = { $exists: false };
    else if (isValidObjectId(params.assignedTo)) filter.assignedTo = new mongoose.Types.ObjectId(params.assignedTo);
    else filter.assignedTo = new mongoose.Types.ObjectId(); // unknown id -> match nothing
  }
  if (typeof params.search === "string" && params.search.trim()) {
    const rx = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ inquiryNumber: rx }, { name: rx }, { email: rx }, { phone: rx }, { purpose: rx }];
  }
  const dateRange: Record<string, Date> = {};
  if (typeof params.dateFrom === "string" && !Number.isNaN(Date.parse(params.dateFrom))) {
    dateRange.$gte = new Date(params.dateFrom);
  }
  if (typeof params.dateTo === "string" && !Number.isNaN(Date.parse(params.dateTo))) {
    dateRange.$lte = new Date(params.dateTo);
  }
  if (Object.keys(dateRange).length) filter.createdAt = dateRange;

  const sort = LIST_SORTS[String(params.sort ?? "")] ?? LIST_SORTS.newest;

  const [docs, total] = await Promise.all([
    Inquiry.find(filter)
      .sort(sort)
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      .exec(),
    Inquiry.countDocuments(filter),
  ]);

  const assigneeIds = [
    ...new Set(docs.map((d) => d.assignedTo?.toString()).filter(Boolean) as string[]),
  ];
  const assignees = assigneeIds.length
    ? await User.find({ _id: { $in: assigneeIds } }).select("firstName lastName phone").lean()
    : [];
  const nameById = new Map(
    assignees.map((u) => [
      u._id.toString(),
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.phone || "Unknown user",
    ])
  );

  return {
    items: docs.map((d) => shapeListItem(d, d.assignedTo ? nameById.get(d.assignedTo.toString()) ?? null : null)),
    page: params.page,
    pageSize: params.pageSize,
    total,
  };
}

export async function getInquiryAdmin(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Inquiry.findById(id).exec();
  if (!doc) return null;

  const [noteDocs, activityDocs] = await Promise.all([
    InquiryNote.find({ inquiryId: doc._id }).sort({ createdAt: -1 }).lean(),
    InquiryActivity.find({ inquiryId: doc._id }).sort({ createdAt: 1 }).lean(),
  ]);

  const userIds = [
    ...new Set(
      [
        doc.assignedTo?.toString(),
        ...noteDocs.map((n) => n.userId?.toString()),
        ...activityDocs.map((a) => a.userId?.toString()),
      ].filter(Boolean) as string[]
    ),
  ];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select("firstName lastName phone").lean()
    : [];
  const nameById = new Map(
    users.map((u) => [
      u._id.toString(),
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.phone || "Unknown user",
    ])
  );

  return {
    inquiryId: doc._id.toString(),
    inquiryNumber: doc.inquiryNumber,
    formType: doc.formType,
    name: doc.name,
    email: doc.email,
    phone: doc.phone ?? null,
    quantity: doc.quantity ?? null,
    purpose: doc.purpose ?? null,
    message: doc.message ?? null,
    status: doc.status,
    assignedTo: doc.assignedTo
      ? { userId: doc.assignedTo.toString(), name: nameById.get(doc.assignedTo.toString()) ?? "Unknown user" }
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    notes: noteDocs.map((n) => ({
      noteId: n._id.toString(),
      note: n.note,
      userName: n.userId ? nameById.get(n.userId.toString()) ?? "Unknown user" : "Unknown user",
      createdAt: n.createdAt.toISOString(),
    })),
    activity: activityDocs.map((a) => ({
      activityId: a._id.toString(),
      action: a.action,
      oldValue: a.oldValue ?? null,
      newValue: a.newValue ?? null,
      userName: a.userId ? nameById.get(a.userId.toString()) ?? "Unknown user" : null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Admin: mutations
// ---------------------------------------------------------------------------

async function assertAdmin(userId: string): Promise<void> {
  if (!isValidObjectId(userId)) throw new AppError("Invalid assignee", 400);
  const user = await User.findById(userId).select("role").lean();
  if (!user || user.role !== "admin") throw new AppError("Inquiries can only be assigned to an admin user", 400);
}

export async function changeInquiryStatus(id: string, status: InquiryStatus, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Inquiry.findById(id).exec();
  if (!doc) return null;

  if (doc.status !== status) {
    const old = doc.status;
    doc.status = status;
    if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);
    await doc.save();
    await writeActivity(doc._id, "STATUS_CHANGED", { userId: actorId, oldValue: old, newValue: status });
    logInquiryEvent("status_changed", { inquiryNumber: doc.inquiryNumber, from: old, to: status, actorId });
  }
  return getInquiryAdmin(id);
}

export async function assignInquiry(id: string, assignedTo: string | null, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Inquiry.findById(id).exec();
  if (!doc) return null;

  const nextId = assignedTo && assignedTo.trim() ? assignedTo.trim() : null;
  if (nextId) await assertAdmin(nextId);

  const currentId = doc.assignedTo?.toString() ?? null;
  if (currentId !== nextId) {
    const [oldName, newName] = await Promise.all([userDisplayName(currentId), userDisplayName(nextId)]);
    doc.assignedTo = nextId ? new mongoose.Types.ObjectId(nextId) : undefined;
    if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);
    await doc.save();
    await writeActivity(doc._id, "ASSIGNED", { userId: actorId, oldValue: oldName, newValue: newName });
    logInquiryEvent("assigned", { inquiryNumber: doc.inquiryNumber, to: newName, actorId });
  }
  return getInquiryAdmin(id);
}

// A single edit that can touch customer fields, status and assignment at once.
// Everything is applied to one loaded doc and saved once; each kind of change
// still gets its own specific activity row (STATUS_CHANGED / ASSIGNED /
// UPDATED). The dedicated changeInquiryStatus / assignInquiry paths above are
// the detail page's quick controls and share the same logging.
export async function updateInquiryAdmin(id: string, patch: UpdateInquiryInput, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Inquiry.findById(id).exec();
  if (!doc) return null;

  const activities: { action: InquiryAction; oldValue?: string; newValue?: string }[] = [];

  if (patch.status !== undefined && patch.status !== doc.status) {
    activities.push({ action: "STATUS_CHANGED", oldValue: doc.status, newValue: patch.status });
    doc.status = patch.status;
  }

  if (patch.assignedTo !== undefined) {
    const nextId = patch.assignedTo && String(patch.assignedTo).trim() ? String(patch.assignedTo) : null;
    const currentId = doc.assignedTo?.toString() ?? null;
    if (currentId !== nextId) {
      if (nextId) await assertAdmin(nextId);
      const [oldName, newName] = await Promise.all([userDisplayName(currentId), userDisplayName(nextId)]);
      activities.push({ action: "ASSIGNED", oldValue: oldName, newValue: newName });
      doc.assignedTo = nextId ? new mongoose.Types.ObjectId(nextId) : undefined;
    }
  }

  let detailsChanged = false;
  // name/email are required — zod guarantees a non-empty trimmed string here.
  if (patch.name !== undefined && doc.name !== patch.name.trim()) {
    doc.name = patch.name.trim();
    detailsChanged = true;
  }
  if (patch.email !== undefined && doc.email !== patch.email.trim()) {
    doc.email = patch.email.trim();
    detailsChanged = true;
  }
  // phone/purpose/message are optional — an empty value clears them.
  const setOptional = (key: "phone" | "purpose" | "message", raw: string | undefined) => {
    if (raw === undefined) return;
    const next = raw.trim() ? raw.trim() : undefined;
    if (doc[key] !== next) {
      doc[key] = next;
      detailsChanged = true;
    }
  };
  setOptional("phone", patch.phone);
  setOptional("purpose", patch.purpose);
  setOptional("message", patch.message);
  if (patch.quantity !== undefined) {
    const q =
      patch.quantity === null || (patch.quantity as unknown) === "" ? undefined : Number(patch.quantity);
    if (doc.quantity !== q) {
      doc.quantity = q;
      detailsChanged = true;
    }
  }
  if (detailsChanged) activities.push({ action: "UPDATED", newValue: "Details edited" });

  if (activities.length === 0) return getInquiryAdmin(id);

  if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);
  await doc.save();
  for (const a of activities) {
    await writeActivity(doc._id, a.action, { userId: actorId, oldValue: a.oldValue, newValue: a.newValue });
  }
  logInquiryEvent("updated", {
    inquiryNumber: doc.inquiryNumber,
    changes: activities.map((a) => a.action),
    actorId,
  });

  return getInquiryAdmin(id);
}

export async function addInquiryNote(id: string, userId: string, note: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Inquiry.findById(id).select("_id inquiryNumber").lean();
  if (!doc) return null;

  await InquiryNote.create({ inquiryId: doc._id, userId: new mongoose.Types.ObjectId(userId), note: note.trim() });
  await writeActivity(doc._id, "NOTE_ADDED", { userId, newValue: "Internal note added" });
  logInquiryEvent("note_added", { inquiryNumber: doc.inquiryNumber, actorId: userId });

  return getInquiryAdmin(id);
}

export async function deleteInquiryAdmin(id: string, actorId?: string): Promise<boolean | null> {
  if (!isValidObjectId(id)) return null;
  const doc = await Inquiry.findById(id).exec();
  if (!doc) return null;

  await Promise.all([
    InquiryNote.deleteMany({ inquiryId: doc._id }),
    InquiryActivity.deleteMany({ inquiryId: doc._id }),
  ]);
  await doc.deleteOne();
  logInquiryEvent("deleted", { inquiryNumber: doc.inquiryNumber, actorId });
  return true;
}

// ---------------------------------------------------------------------------
// Admin: stats + assignees
// ---------------------------------------------------------------------------

export async function getInquiryStats(): Promise<{ total: number; byStatus: Record<InquiryStatus, number> }> {
  const rows = await Inquiry.aggregate<{ _id: InquiryStatus; count: number }>([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(INQUIRY_STATUSES.map((s) => [s, 0])) as Record<InquiryStatus, number>;
  let total = 0;
  for (const row of rows) {
    if (row._id in byStatus) byStatus[row._id] = row.count;
    total += row.count;
  }
  return { total, byStatus };
}

export async function listAdminAssignees(): Promise<{ id: string; name: string }[]> {
  const admins = await User.find({ role: "admin" }).select("firstName lastName phone").sort({ firstName: 1 }).lean();
  return admins.map((u) => ({
    id: u._id.toString(),
    name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.phone || "Admin",
  }));
}
