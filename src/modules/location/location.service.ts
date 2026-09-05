import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import { getGeoProvider } from "./location.provider";
import type { ResolvedLocation, ServiceabilityResult } from "./location.types";

const OUTBOUND_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = env.locationCacheTtlMinutes * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Tiny in-process TTL cache so a burst of visitors (or one visitor typing in
// the search box) doesn't repeatedly hit the upstream geocoder. Bounded size;
// oldest entry is evicted when full. Not shared across worker processes — that's
// fine, each worker warms its own and upstream still sees far less traffic.
const cache = new Map<string, { value: unknown; expires: number }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// AbortController-backed timeout — a hung upstream must never hold a request
// open. Distinguishes "we gave up" from a real upstream error.
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppError("The location service took too long to respond", 504);
    }
    throw new AppError("Couldn't reach the location service", 502);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Reverse geocoding ---------------------------------------------------------

export async function reverseGeocode(lat: number, lng: number): Promise<ResolvedLocation> {
  // Round to ~100m so near-identical coordinates share a cache entry (and so
  // the cache key isn't a high-precision fingerprint sitting in memory).
  const key = `rev:${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = cacheGet<ResolvedLocation>(key);
  if (cached) return cached;

  const provider = getGeoProvider();
  const resolved = await withTimeout((signal) => provider.reverse(lat, lng, signal));
  // Carry the caller's precise coordinates back so the client can store the
  // real fix locally; the cached copy keeps the rounded ones only.
  const withCoords: ResolvedLocation = { ...resolved, latitude: lat, longitude: lng };
  cacheSet(key, resolved);
  return withCoords;
}

// ---- Search (city / area / PIN) ---------------------------------------------

export async function searchLocations(query: string): Promise<ResolvedLocation[]> {
  const normalized = query.trim().toLowerCase();
  const key = `search:${normalized}`;
  const cached = cacheGet<ResolvedLocation[]>(key);
  if (cached) return cached;

  const provider = getGeoProvider();
  const results = await withTimeout((signal) => provider.search(query.trim(), signal));
  cacheSet(key, results);
  return results;
}

// ---- IP-based approximate fallback ------------------------------------------

interface IpApiResponse {
  city?: string;
  region?: string;
  region_code?: string;
  country_name?: string;
  postal?: string;
  latitude?: number;
  longitude?: number;
  error?: boolean;
  reason?: string;
}

// `ip` comes from req.ip (the controller passes it) — it is used only to build
// the upstream URL and is NEVER returned to the client or logged here.
export async function getLocationFromIp(ip: string | undefined): Promise<ResolvedLocation> {
  // Node/Express often hands back IPv4-mapped IPv6 ("::ffff:127.0.0.1").
  const clean = (ip ?? "").trim().replace(/^::ffff:/i, "");
  // Loopback / private / link-local / missing → the upstream can't do
  // anything useful with it, so don't even make the call.
  const isUsable =
    clean.length > 0 &&
    clean !== "::1" &&
    !clean.startsWith("127.") &&
    !clean.startsWith("10.") &&
    !clean.startsWith("192.168.") &&
    !clean.startsWith("169.254.") &&
    !/^172\.(1[6-9]|2\d|3[01])\./.test(clean) &&
    !/^f[cd][0-9a-f]{2}:/i.test(clean); // fc00::/7 unique-local IPv6

  if (!isUsable) {
    throw new AppError("Approximate location isn't available", 404);
  }

  const key = `ip:${clean}`;
  const cached = cacheGet<ResolvedLocation>(key);
  if (cached) return cached;

  const data = await withTimeout(async (signal) => {
    const res = await fetch(`${env.ipGeoBaseUrl}/${encodeURIComponent(clean)}/json/`, {
      signal,
      headers: { Accept: "application/json", "User-Agent": env.nominatimUserAgent },
    });
    if (!res.ok) throw new AppError("Approximate location isn't available", 502);
    return (await res.json()) as IpApiResponse;
  });

  if (!data || data.error || (!data.city && !data.region && !data.postal)) {
    throw new AppError("Approximate location isn't available", 404);
  }

  const displayName =
    [data.city, data.region].filter(Boolean).join(", ") ||
    data.country_name ||
    "Approximate area";

  const resolved: ResolvedLocation = {
    displayName,
    provider: "ipapi",
    approximate: true,
  };
  if (data.city) resolved.city = data.city;
  if (data.region) resolved.state = data.region;
  if (data.country_name) resolved.country = data.country_name;
  if (data.postal) resolved.postalCode = data.postal;
  // Deliberately NOT copying latitude/longitude from IP geolocation — it's a
  // city-level guess, not a fix; treating it as precise coordinates would be
  // misleading for anything delivery-related.

  cacheSet(key, resolved);
  return resolved;
}

// ---- Serviceability (extension seam — brief §6) ---------------------------

// Today the storefront ships anywhere in India at a flat rate (see
// StoreSettings), so this is the whole of the serviceability rule. When real
// delivery zones / warehouses / per-PIN rates arrive, THIS is the one function
// to grow — every caller (frontend `validateServiceability`, a future checkout
// gate) already routes through it.
export function checkServiceability(input: {
  pincode?: string;
  country?: string;
}): ServiceabilityResult {
  const serviceable = input.country == null || input.country === "India";
  return {
    serviceable,
    pincode: input.pincode,
    note: serviceable
      ? "Confirm your exact delivery address at checkout."
      : "We currently deliver within India only.",
  };
}
