import { InstagramPost } from "../../database/models";

// The (platform, postType, shortCode) UNIQUE index is the DB-level dedupe the
// concurrency guarantee rests on (spec §7/§24). Mongoose autoIndex builds it
// in the background on first use and is often disabled in production, so —
// exactly like ensureUserAuthIndexes / ensureCouponIndexes — this makes the
// build explicit and awaited at boot. createIndexes() only ADDS what the
// schema declares and the collection lacks; it never drops.
export async function ensureInstagramPostIndexes(): Promise<void> {
  await InstagramPost.createIndexes();
  console.log("[instagram-post] indexes ensured (platform+postType+shortCode unique)");
}
