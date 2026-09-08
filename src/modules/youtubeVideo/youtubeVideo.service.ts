import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  YouTubeVideo,
  YouTubeVideoDocument,
  YouTubeVideoStatus,
  YOUTUBE_VIDEO_STATUSES,
} from "../../database/models";
import { parseYouTubeUrl, YOUTUBE_URL_ERROR_MESSAGES } from "./youtubeUrl";
import type {
  CreateYouTubeVideoInput,
  UpdateYouTubeVideoInput,
} from "./youtubeVideo.validation";

// Controller → service → model. The service owns URL normalisation,
// duplicate handling, display-order defaulting and status transitions.

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

const DUPLICATE_MESSAGE = "This YouTube video has already been added";

export function toYouTubeVideoDto(doc: YouTubeVideoDocument) {
  return {
    id: doc._id.toString(),
    url: doc.url,
    platform: doc.platform,
    videoType: doc.videoType,
    videoId: doc.videoId,
    displayOrder: doc.displayOrder,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export type YouTubeVideoDto = ReturnType<typeof toYouTubeVideoDto>;

// ---- List ----

export interface ListYouTubeVideosParams {
  page: number;
  pageSize: number;
  search?: unknown;
  status?: unknown;
}

export async function listYouTubeVideos(params: ListYouTubeVideosParams) {
  const filter: Record<string, unknown> = {};

  if (
    typeof params.status === "string" &&
    (YOUTUBE_VIDEO_STATUSES as readonly string[]).includes(params.status)
  ) {
    filter.status = params.status;
  } else {
    filter.status = { $ne: "ARCHIVED" };
  }

  if (typeof params.search === "string" && params.search.trim()) {
    const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ videoId: pattern }, { url: pattern }];
  }

  const [docs, total] = await Promise.all([
    YouTubeVideo.find(filter)
      .sort({ displayOrder: 1, createdAt: 1 })
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      .exec(),
    YouTubeVideo.countDocuments(filter),
  ]);

  return {
    items: docs.map(toYouTubeVideoDto),
    page: params.page,
    pageSize: params.pageSize,
    total,
  };
}

// ---- Get one ----

export async function getYouTubeVideoById(id: string): Promise<YouTubeVideoDto> {
  if (!isValidObjectId(id)) throw new AppError("YouTube video not found", 404);
  const doc = await YouTubeVideo.findById(id).exec();
  if (!doc) throw new AppError("YouTube video not found", 404);
  return toYouTubeVideoDto(doc);
}

// ---- Create ----

async function nextDisplayOrder(): Promise<number> {
  const last = await YouTubeVideo.findOne().sort({ displayOrder: -1 }).select("displayOrder").lean();
  return (last?.displayOrder ?? 0) + 1;
}

export async function createYouTubeVideo(
  input: CreateYouTubeVideoInput,
  adminId?: string
): Promise<YouTubeVideoDto> {
  const parsed = parseYouTubeUrl(input.url);
  if (!parsed.ok) {
    throw new AppError(YOUTUBE_URL_ERROR_MESSAGES[parsed.error], 400);
  }

  try {
    const doc = await YouTubeVideo.create({
      url: parsed.value.canonicalUrl,
      platform: parsed.value.platform,
      videoType: parsed.value.videoType,
      videoId: parsed.value.videoId,
      displayOrder: input.displayOrder ?? (await nextDisplayOrder()),
      status: input.status ?? "ACTIVE",
      createdBy: adminId ? new mongoose.Types.ObjectId(adminId) : undefined,
    });
    return toYouTubeVideoDto(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }
}

// ---- Update ----

export async function updateYouTubeVideo(
  id: string,
  patch: UpdateYouTubeVideoInput,
  adminId?: string
): Promise<YouTubeVideoDto> {
  if (!isValidObjectId(id)) throw new AppError("YouTube video not found", 404);
  const doc = await YouTubeVideo.findById(id).exec();
  if (!doc) throw new AppError("YouTube video not found", 404);

  if (patch.url !== undefined) {
    const parsed = parseYouTubeUrl(patch.url);
    if (!parsed.ok) throw new AppError(YOUTUBE_URL_ERROR_MESSAGES[parsed.error], 400);
    doc.url = parsed.value.canonicalUrl;
    doc.platform = parsed.value.platform;
    doc.videoType = parsed.value.videoType;
    doc.videoId = parsed.value.videoId;
  }
  if (patch.displayOrder !== undefined) doc.displayOrder = patch.displayOrder;
  if (patch.status !== undefined) doc.status = patch.status;

  doc.updatedBy = adminId ? new mongoose.Types.ObjectId(adminId) : doc.updatedBy;

  try {
    await doc.save();
    return toYouTubeVideoDto(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }
}

// ---- Status / archive ----

export async function setYouTubeVideoStatus(
  id: string,
  status: YouTubeVideoStatus,
  adminId?: string
): Promise<YouTubeVideoDto> {
  if (!isValidObjectId(id)) throw new AppError("YouTube video not found", 404);
  const doc = await YouTubeVideo.findById(id).exec();
  if (!doc) throw new AppError("YouTube video not found", 404);

  doc.status = status;
  doc.updatedBy = adminId ? new mongoose.Types.ObjectId(adminId) : doc.updatedBy;
  await doc.save();
  return toYouTubeVideoDto(doc);
}

// Soft delete — DELETE archives rather than destroys. Idempotent.
export async function archiveYouTubeVideo(id: string, adminId?: string): Promise<YouTubeVideoDto> {
  return setYouTubeVideoStatus(id, "ARCHIVED", adminId);
}
