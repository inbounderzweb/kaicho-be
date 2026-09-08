import { Schema, model, Document, Types } from "mongoose";

// A curated reference to a public YouTube video/short the storefront may
// later surface. Same shape and intent as InstagramPost.model.ts — we store
// only the PUBLIC identity of the video (its 11-char id), never media,
// captions, view counts or scraped HTML. Customer side / sync are out of
// scope for this phase.
//
// Identity is (platform, videoId) — a Short (`/shorts/ID`) and the regular
// watch URL (`watch?v=ID`) are the SAME video, so `videoType` is only "how
// it was added", not part of the key. youtubeUrl.ts canonicalises every URL
// spelling to that id, and the unique index below is the last-line guard
// against a duplicate on two concurrent creates.

export const YOUTUBE_PLATFORMS = ["YOUTUBE"] as const;
export type YouTubePlatform = (typeof YOUTUBE_PLATFORMS)[number];

export const YOUTUBE_VIDEO_TYPES = ["VIDEO", "SHORT"] as const;
export type YouTubeVideoType = (typeof YOUTUBE_VIDEO_TYPES)[number];

export const YOUTUBE_VIDEO_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type YouTubeVideoStatus = (typeof YOUTUBE_VIDEO_STATUSES)[number];

export interface YouTubeVideoDocument extends Document {
  // Canonical URL — `https://www.youtube.com/watch?v={videoId}` for a video,
  // `https://www.youtube.com/shorts/{videoId}` for a short. Safe as an href.
  url: string;
  platform: YouTubePlatform;
  videoType: YouTubeVideoType;
  videoId: string;
  displayOrder: number;
  status: YouTubeVideoStatus;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const YouTubeVideoSchema = new Schema<YouTubeVideoDocument>(
  {
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    platform: { type: String, enum: YOUTUBE_PLATFORMS, required: true, default: "YOUTUBE" },
    videoType: { type: String, enum: YOUTUBE_VIDEO_TYPES, required: true },
    // YouTube video ids are exactly 11 url-safe base64 chars.
    videoId: { type: String, required: true, trim: true, maxlength: 16 },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: YOUTUBE_VIDEO_STATUSES, required: true, default: "ACTIVE" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// DB-level dedupe on the real identity — one row per video regardless of URL
// spelling or whether it was pasted as a short.
YouTubeVideoSchema.index({ platform: 1, videoId: 1 }, { unique: true });
// The listing sorts by displayOrder; a future public API filters
// status=ACTIVE ordered by displayOrder — one composite index serves both.
YouTubeVideoSchema.index({ status: 1, displayOrder: 1 });

export const YouTubeVideo = model<YouTubeVideoDocument>("YouTubeVideo", YouTubeVideoSchema);
