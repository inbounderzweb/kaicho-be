import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  InstagramPost,
  InstagramPostDocument,
  InstagramPostStatus,
  INSTAGRAM_POST_STATUSES,
} from "../../database/models";
import { parseInstagramUrl, INSTAGRAM_URL_ERROR_MESSAGES } from "./instagramUrl";
import type {
  CreateInstagramPostInput,
  UpdateInstagramPostInput,
} from "./instagramPost.validation";

// Controller → service → model. The service owns every business rule:
// URL normalisation, duplicate handling, display-order defaulting and status
// transitions. Controllers only parse the request and shape the response.

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A Mongo duplicate-key error on the (platform, postType, shortCode) unique
// index — the race two concurrent creates hit (spec §24). Turned into a
// clean 409 rather than a 500.
function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

const DUPLICATE_MESSAGE = "This Instagram post has already been added";

// ---- DTO ----
// Only what a client needs. Internal ids (createdBy) and the Mongo `__v`
// never leave here.
export function toInstagramPostDto(doc: InstagramPostDocument) {
  return {
    id: doc._id.toString(),
    url: doc.url,
    platform: doc.platform,
    postType: doc.postType,
    shortCode: doc.shortCode,
    displayOrder: doc.displayOrder,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export type InstagramPostDto = ReturnType<typeof toInstagramPostDto>;

// ---- List ----

export interface ListInstagramPostsParams {
  page: number;
  pageSize: number;
  search?: unknown;
  status?: unknown;
}

export async function listInstagramPosts(params: ListInstagramPostsParams) {
  const filter: Record<string, unknown> = {};

  if (
    typeof params.status === "string" &&
    (INSTAGRAM_POST_STATUSES as readonly string[]).includes(params.status)
  ) {
    filter.status = params.status;
  } else {
    // Default view hides archived posts (spec §20) — they're only reachable
    // by explicitly asking for status=ARCHIVED.
    filter.status = { $ne: "ARCHIVED" };
  }

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ shortCode: pattern }, { url: pattern }];
  }

  const [docs, total] = await Promise.all([
    InstagramPost.find(filter)
      .sort({ displayOrder: 1, createdAt: 1 })
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      .exec(),
    InstagramPost.countDocuments(filter),
  ]);

  return {
    items: docs.map(toInstagramPostDto),
    page: params.page,
    pageSize: params.pageSize,
    total,
  };
}

// ---- Get one ----

export async function getInstagramPostById(id: string): Promise<InstagramPostDto> {
  if (!isValidObjectId(id)) throw new AppError("Instagram post not found", 404);
  const doc = await InstagramPost.findById(id).exec();
  if (!doc) throw new AppError("Instagram post not found", 404);
  return toInstagramPostDto(doc);
}

// ---- Create ----

async function nextDisplayOrder(): Promise<number> {
  const last = await InstagramPost.findOne().sort({ displayOrder: -1 }).select("displayOrder").lean();
  return (last?.displayOrder ?? 0) + 1;
}

export async function createInstagramPost(
  input: CreateInstagramPostInput,
  adminId?: string
): Promise<InstagramPostDto> {
  // The Zod layer already ran this successfully; re-running it here is how the
  // service gets the normalised triple without trusting a pre-parsed value.
  const parsed = parseInstagramUrl(input.url);
  if (!parsed.ok) {
    throw new AppError(INSTAGRAM_URL_ERROR_MESSAGES[parsed.error], 400);
  }

  try {
    const doc = await InstagramPost.create({
      url: parsed.value.canonicalUrl,
      platform: parsed.value.platform,
      postType: parsed.value.postType,
      shortCode: parsed.value.shortCode,
      displayOrder: input.displayOrder ?? (await nextDisplayOrder()),
      status: input.status ?? "ACTIVE",
      createdBy: adminId ? new mongoose.Types.ObjectId(adminId) : undefined,
    });
    return toInstagramPostDto(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }
}

// ---- Update ----

export async function updateInstagramPost(
  id: string,
  patch: UpdateInstagramPostInput,
  adminId?: string
): Promise<InstagramPostDto> {
  if (!isValidObjectId(id)) throw new AppError("Instagram post not found", 404);
  const doc = await InstagramPost.findById(id).exec();
  if (!doc) throw new AppError("Instagram post not found", 404);

  if (patch.url !== undefined) {
    const parsed = parseInstagramUrl(patch.url);
    if (!parsed.ok) throw new AppError(INSTAGRAM_URL_ERROR_MESSAGES[parsed.error], 400);
    doc.url = parsed.value.canonicalUrl;
    doc.platform = parsed.value.platform;
    doc.postType = parsed.value.postType;
    doc.shortCode = parsed.value.shortCode;
  }
  if (patch.displayOrder !== undefined) doc.displayOrder = patch.displayOrder;
  if (patch.status !== undefined) doc.status = patch.status;

  doc.updatedBy = adminId ? new mongoose.Types.ObjectId(adminId) : doc.updatedBy;

  try {
    await doc.save();
    return toInstagramPostDto(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }
}

// ---- Status / archive ----

export async function setInstagramPostStatus(
  id: string,
  status: InstagramPostStatus,
  adminId?: string
): Promise<InstagramPostDto> {
  if (!isValidObjectId(id)) throw new AppError("Instagram post not found", 404);
  const doc = await InstagramPost.findById(id).exec();
  if (!doc) throw new AppError("Instagram post not found", 404);

  doc.status = status;
  doc.updatedBy = adminId ? new mongoose.Types.ObjectId(adminId) : doc.updatedBy;
  await doc.save();
  return toInstagramPostDto(doc);
}

// Soft delete — an Instagram reference is cheap to keep and may be worth
// restoring, so DELETE archives rather than destroys (spec §20). Idempotent:
// archiving an already-archived post is a no-op success.
export async function archiveInstagramPost(id: string, adminId?: string): Promise<InstagramPostDto> {
  return setInstagramPostStatus(id, "ARCHIVED", adminId);
}
