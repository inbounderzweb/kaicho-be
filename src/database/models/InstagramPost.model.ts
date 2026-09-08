import { Schema, model, Document, Types } from "mongoose";

// A curated reference to a public Instagram post/reel that the storefront may
// later surface (the "latest from Instagram" strip). We store only the
// PUBLIC identity of the post — never media, credentials, tokens or scraped
// HTML (spec §4). The customer side and any sync are explicitly out of scope
// for this phase.
//
// Identity is (platform, postType, shortCode), NOT the raw URL: the same
// post arrives as many URL spellings (http/https, with/without www, tracking
// query params). instagramUrl.ts canonicalises every input to that triple,
// and the unique index below is the last line of defence against a
// duplicate slipping through on two concurrent creates (spec §6/§7/§24).
//
// `platform` is a fixed enum of one today. It exists so a future "also allow
// a YouTube short / a TikTok" is an enum addition, not a schema migration —
// the same forward-compatible shape Coupon/Order enums use here.

export const SOCIAL_PLATFORMS = ["INSTAGRAM"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const INSTAGRAM_POST_TYPES = ["POST", "REEL"] as const;
export type InstagramPostType = (typeof INSTAGRAM_POST_TYPES)[number];

export const INSTAGRAM_POST_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type InstagramPostStatus = (typeof INSTAGRAM_POST_STATUSES)[number];

export interface InstagramPostDocument extends Document {
  // Canonical URL — always `https://www.instagram.com/{p|reel}/{shortCode}/`.
  // Derived from the raw admin input; safe to render as an href.
  url: string;
  platform: SocialPlatform;
  postType: InstagramPostType;
  shortCode: string;
  displayOrder: number;
  status: InstagramPostStatus;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const InstagramPostSchema = new Schema<InstagramPostDocument>(
  {
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    platform: { type: String, enum: SOCIAL_PLATFORMS, required: true, default: "INSTAGRAM" },
    postType: { type: String, enum: INSTAGRAM_POST_TYPES, required: true },
    // Instagram short codes are ~11 url-safe base64 chars; 64 is generous
    // headroom without inviting junk.
    shortCode: { type: String, required: true, trim: true, maxlength: 64 },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: INSTAGRAM_POST_STATUSES, required: true, default: "ACTIVE" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// DB-level dedupe on the real identity (spec §7).
InstagramPostSchema.index({ platform: 1, postType: 1, shortCode: 1 }, { unique: true });
// The listing sorts by displayOrder; the future public API will filter
// status=ACTIVE and order by displayOrder — one composite index serves both.
InstagramPostSchema.index({ status: 1, displayOrder: 1 });

export const InstagramPost = model<InstagramPostDocument>("InstagramPost", InstagramPostSchema);
