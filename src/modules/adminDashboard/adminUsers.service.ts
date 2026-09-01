import mongoose from "mongoose";
import { User, UserDocument } from "../../database/models";
import { ROLES, UserRole } from "../../common/constants/roles";

// Whitelisted against arbitrary client-supplied field names before ever
// reaching Mongoose's .sort() — not just a UX nicety.
const SORTABLE_FIELDS = ["createdAt", "lastLoginAt", "phone", "role"] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];
const DEFAULT_SORT_FIELD: SortableField = "createdAt";

const LIST_SELECT = "phone countryCode firstName lastName email role isActive lastLoginAt createdAt";

function resolveSortField(raw: unknown): SortableField {
  return typeof raw === "string" && (SORTABLE_FIELDS as readonly string[]).includes(raw)
    ? (raw as SortableField)
    : DEFAULT_SORT_FIELD;
}

// User-supplied search text is embedded in a RegExp — escape it first so a
// value like "a(" can't throw, and so regex metacharacters can't be used to
// build an unintended, expensive pattern.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

type LeanUser = Pick<
  UserDocument,
  | "phone"
  | "countryCode"
  | "firstName"
  | "lastName"
  | "email"
  | "role"
  | "isActive"
  | "lastLoginAt"
  | "createdAt"
> & { _id: mongoose.Types.ObjectId; addresses?: UserDocument["addresses"] };

function toListItem(u: LeanUser) {
  return {
    id: u._id.toString(),
    name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "—",
    firstName: u.firstName ?? "",
    lastName: u.lastName ?? "",
    phone: `${u.countryCode} ${u.phone}`,
    email: u.email ?? null,
    role: u.role,
    status: u.isActive ? ("Active" as const) : ("Inactive" as const),
    joinedAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

function toDetailItem(u: LeanUser) {
  return {
    ...toListItem(u),
    countryCode: u.countryCode,
    addresses: (u.addresses ?? []).map((a) => ({
      id: a._id?.toString(),
      label: a.label ?? null,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      isDefault: Boolean(a.isDefault),
    })),
  };
}

export interface UsersListParams {
  page: number;
  pageSize: number;
  excludeUserId: string;
  sortBy?: unknown;
  sortOrder?: unknown;
  search?: unknown;
  status?: unknown;
  role?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
}

function buildFilter({
  excludeUserId,
  search,
  status,
  role,
  dateFrom,
  dateTo,
}: UsersListParams): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: { $ne: excludeUserId } };

  if (typeof search === "string" && search.trim()) {
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ firstName: pattern }, { lastName: pattern }, { phone: pattern }, { email: pattern }];
  }

  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;

  if (typeof role === "string" && (ROLES as readonly string[]).includes(role)) {
    filter.role = role;
  }

  const createdAt: Record<string, Date> = {};
  if (typeof dateFrom === "string") {
    const d = new Date(dateFrom);
    if (!Number.isNaN(d.getTime())) createdAt.$gte = d;
  }
  if (typeof dateTo === "string") {
    const d = new Date(dateTo);
    if (!Number.isNaN(d.getTime())) createdAt.$lte = d;
  }
  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

  return filter;
}

export async function getUsersList(params: UsersListParams) {
  const { page, pageSize, sortBy, sortOrder } = params;
  const field = resolveSortField(sortBy);
  const direction: 1 | -1 = sortOrder === "asc" ? 1 : -1;
  // "hide own profile": the requesting admin never sees themselves in the
  // user-management list, regardless of search/filter/sort/page.
  const filter = buildFilter(params);

  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort({ [field]: direction })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select(LIST_SELECT)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    items: docs.map((u) => toListItem(u as unknown as LeanUser)),
    page,
    pageSize,
    total,
    sortBy: field,
    sortOrder: direction === 1 ? "asc" : "desc",
  };
}

export async function getUsersStats(excludeUserId: string) {
  const base = { _id: { $ne: excludeUserId } };
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totalUsers, activeUsers, inactiveUsers, newUsersLast30Days] = await Promise.all([
    User.countDocuments(base),
    User.countDocuments({ ...base, isActive: true }),
    User.countDocuments({ ...base, isActive: false }),
    User.countDocuments({ ...base, createdAt: { $gte: thirtyDaysAgo } }),
  ]);

  return { totalUsers, activeUsers, inactiveUsers, newUsersLast30Days };
}

// Used by the dashboard's "Total Users" stat — the true site-wide count,
// distinct from getUsersStats() which is scoped to the users-management
// page and excludes the requesting admin for consistency with the list.
export async function countAllUsers(): Promise<number> {
  return User.countDocuments();
}

// Site-wide new-signup count since `since` — the dashboard's growth signal.
// Not scoped to exclude the requesting admin (unlike getUsersStats): the
// dashboard reports the whole store, not the users-management view.
export async function countUsersSince(since: Date): Promise<number> {
  return User.countDocuments({ createdAt: { $gte: since } });
}

export async function getUserById(id: string, excludeUserId: string) {
  // Malformed id, not-found, and "that id is yourself" all return the same
  // null → the controller turns this into a single generic 404, matching
  // requireAuth's own "don't reveal which case it was" posture.
  if (!isValidObjectId(id) || id === excludeUserId) return null;

  const doc = await User.findById(id).lean();
  if (!doc) return null;

  return toDetailItem(doc as unknown as LeanUser);
}

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: UserRole;
  isActive?: boolean;
}

export async function updateUserById(id: string, excludeUserId: string, patch: UpdateUserInput) {
  if (!isValidObjectId(id) || id === excludeUserId) return null;

  // $set with an explicitly-typed, already-Zod-validated patch object —
  // never a raw req.body spread near the model, so there is no path for a
  // client to smuggle in tokenVersion/passwordHash-equivalent fields.
  const doc = await User.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" }).lean();
  if (!doc) return null;

  return toDetailItem(doc as unknown as LeanUser);
}
