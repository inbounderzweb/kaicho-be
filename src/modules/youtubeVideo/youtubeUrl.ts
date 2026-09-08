import type { YouTubeVideoType } from "../../database/models";

// The ONE place a YouTube URL is validated and normalised. Reused by the
// create and update paths so the rules can never drift. Pure and
// dependency-free; returns a discriminated result so callers get a precise
// reason on failure.

export interface ParsedYouTubeUrl {
  platform: "YOUTUBE";
  videoType: YouTubeVideoType;
  videoId: string;
  /** `https://www.youtube.com/watch?v={id}` for a video,
   *  `https://www.youtube.com/shorts/{id}` for a short. */
  canonicalUrl: string;
}

export type YouTubeUrlError =
  | "EMPTY"
  | "TOO_LONG"
  | "MALFORMED"
  | "NOT_HTTPS"
  | "NOT_YOUTUBE_HOST"
  | "UNSUPPORTED_PATH"
  | "INVALID_VIDEO_ID";

export const MAX_YOUTUBE_URL_LENGTH = 2048;

// YouTube video ids are exactly 11 url-safe base64 chars.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const SHORT_HOST = "youtu.be";

function classify(pathname: string, searchParams: URLSearchParams): { id: string; type: YouTubeVideoType } | null {
  // /watch?v=ID  (also /watch/ID is not a thing; ignore)
  if (pathname === "/watch" || pathname === "/watch/") {
    const v = searchParams.get("v");
    return v ? { id: v, type: "VIDEO" } : null;
  }
  // /shorts/ID
  let m = /^\/shorts\/([^/]+)\/?$/.exec(pathname);
  if (m) return { id: m[1], type: "SHORT" };
  // /embed/ID  and  /live/ID  and  /v/ID  → all normalise to a plain video
  m = /^\/(?:embed|live|v)\/([^/]+)\/?$/.exec(pathname);
  if (m) return { id: m[1], type: "VIDEO" };
  return null;
}

export function parseYouTubeUrl(
  raw: unknown
): { ok: true; value: ParsedYouTubeUrl } | { ok: false; error: YouTubeUrlError } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "EMPTY" };
  const input = raw.trim();
  if (input.length > MAX_YOUTUBE_URL_LENGTH) return { ok: false, error: "TOO_LONG" };

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "MALFORMED" };
  }

  // Rejects javascript:, data:, file:, http: — anything but https.
  if (parsed.protocol !== "https:") return { ok: false, error: "NOT_HTTPS" };

  const host = parsed.hostname.toLowerCase();
  let found: { id: string; type: YouTubeVideoType } | null = null;

  if (host === SHORT_HOST) {
    // youtu.be/ID  (the path IS the id)
    const m = /^\/([^/]+)\/?$/.exec(parsed.pathname);
    found = m ? { id: m[1], type: "VIDEO" } : null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    found = classify(parsed.pathname, parsed.searchParams);
  } else {
    return { ok: false, error: "NOT_YOUTUBE_HOST" };
  }

  if (!found) return { ok: false, error: "UNSUPPORTED_PATH" };
  if (!VIDEO_ID_RE.test(found.id)) return { ok: false, error: "INVALID_VIDEO_ID" };

  const canonicalUrl =
    found.type === "SHORT"
      ? `https://www.youtube.com/shorts/${found.id}`
      : `https://www.youtube.com/watch?v=${found.id}`;

  return {
    ok: true,
    value: { platform: "YOUTUBE", videoType: found.type, videoId: found.id, canonicalUrl },
  };
}

export const YOUTUBE_URL_ERROR_MESSAGES: Record<YouTubeUrlError, string> = {
  EMPTY: "Enter a YouTube video URL",
  TOO_LONG: "That URL is too long",
  MALFORMED: "That doesn't look like a valid URL",
  NOT_HTTPS: "The URL must start with https://",
  NOT_YOUTUBE_HOST: "Only youtube.com and youtu.be URLs are allowed",
  UNSUPPORTED_PATH: "Paste a YouTube video (/watch?v=), short (/shorts/) or youtu.be link",
  INVALID_VIDEO_ID: "That YouTube link is missing a valid video id",
};
