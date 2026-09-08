import type { InstagramPostType } from "../../database/models";

// The ONE place an Instagram URL is validated and normalised. Reused by the
// create and update paths so the rules can never drift between them
// (spec §11/§19). Pure, dependency-free, and returns a discriminated result
// so callers get a precise reason on failure.

export interface ParsedInstagramUrl {
  platform: "INSTAGRAM";
  postType: InstagramPostType;
  shortCode: string;
  /** Always `https://www.instagram.com/{p|reel}/{shortCode}/` — query,
   *  fragment, host and trailing-slash differences all collapsed away. */
  canonicalUrl: string;
}

export type InstagramUrlError =
  | "EMPTY"
  | "TOO_LONG"
  | "MALFORMED"
  | "NOT_HTTPS"
  | "NOT_INSTAGRAM_HOST"
  | "UNSUPPORTED_PATH"
  | "INVALID_SHORTCODE";

export const MAX_INSTAGRAM_URL_LENGTH = 2048;

// Instagram short codes are URL-safe base64: letters, digits, - and _.
const SHORTCODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Only the canonical apex + www hosts. A string that merely *contains*
// "instagram" (evil.com/instagram.com/p/x) never matches (spec §12).
const ALLOWED_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

// `/p/<code>` → POST, `/reel/<code>` or `/reels/<code>` → REEL. Nothing else
// (profiles, stories, tv, explore, tagged pages…) is a shareable single-post
// reference, so it's rejected rather than guessed at.
const PATH_RE = /^\/(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/;

export function parseInstagramUrl(
  raw: unknown
): { ok: true; value: ParsedInstagramUrl } | { ok: false; error: InstagramUrlError } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "EMPTY" };
  const input = raw.trim();
  if (input.length > MAX_INSTAGRAM_URL_LENGTH) return { ok: false, error: "TOO_LONG" };

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "MALFORMED" };
  }

  // Rejects javascript:, data:, file:, http: — anything but https.
  if (parsed.protocol !== "https:") return { ok: false, error: "NOT_HTTPS" };
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { ok: false, error: "NOT_INSTAGRAM_HOST" };
  }

  const match = PATH_RE.exec(parsed.pathname);
  if (!match) return { ok: false, error: "UNSUPPORTED_PATH" };

  const postType: InstagramPostType = match[1] === "p" ? "POST" : "REEL";
  const shortCode = match[2];
  if (!SHORTCODE_RE.test(shortCode)) return { ok: false, error: "INVALID_SHORTCODE" };

  const segment = postType === "POST" ? "p" : "reel";
  return {
    ok: true,
    value: {
      platform: "INSTAGRAM",
      postType,
      shortCode,
      canonicalUrl: `https://www.instagram.com/${segment}/${shortCode}/`,
    },
  };
}

export const INSTAGRAM_URL_ERROR_MESSAGES: Record<InstagramUrlError, string> = {
  EMPTY: "Enter an Instagram post URL",
  TOO_LONG: "That URL is too long",
  MALFORMED: "That doesn't look like a valid URL",
  NOT_HTTPS: "The URL must start with https://",
  NOT_INSTAGRAM_HOST: "Only instagram.com URLs are allowed",
  UNSUPPORTED_PATH: "Only Instagram post (/p/) and reel (/reel/) links are supported",
  INVALID_SHORTCODE: "That Instagram link is missing a valid post code",
};
