import { YouTubeVideo } from "../../database/models";

// The (platform, videoId) UNIQUE index is the DB-level dedupe the concurrency
// guarantee rests on. Built explicitly and awaited at boot — same rationale
// as ensureInstagramPostIndexes / ensureCouponIndexes (autoIndex races a
// cold unique index and is often disabled in production). Additive only.
export async function ensureYouTubeVideoIndexes(): Promise<void> {
  await YouTubeVideo.createIndexes();
  console.log("[youtube-video] indexes ensured (platform+videoId unique)");
}
