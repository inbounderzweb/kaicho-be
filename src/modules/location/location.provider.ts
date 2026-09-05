import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import type { ResolvedLocation } from "./location.types";

// Provider abstraction (brief §12). The rest of the module — and the whole
// frontend — only ever depends on this interface, so swapping Nominatim for
// Google/Mapbox later is a change confined to this file.
export interface GeoProvider {
  readonly name: ResolvedLocation["provider"];
  reverse(lat: number, lng: number, signal: AbortSignal): Promise<ResolvedLocation>;
  search(query: string, signal: AbortSignal): Promise<ResolvedLocation[]>;
}

// ---- Nominatim (OpenStreetMap) -------------------------------------------------

interface NominatimAddress {
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  hamlet?: string;
  village?: string;
  town?: string;
  city?: string;
  municipality?: string;
  county?: string;
  state_district?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: NominatimAddress;
}

function pickCity(a: NominatimAddress): string | undefined {
  return (
    a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.suburb ?? a.county
  );
}

function pickLocality(a: NominatimAddress): string | undefined {
  return a.suburb ?? a.neighbourhood ?? a.hamlet ?? a.village ?? a.city ?? a.town;
}

function toResolved(place: NominatimPlace): ResolvedLocation {
  const a = place.address ?? {};
  const city = pickCity(a);
  const locality = pickLocality(a);
  const state = a.state;
  const country = a.country;
  const postalCode = a.postcode;

  const addressLine =
    [a.road, locality, city].filter(Boolean).join(", ") ||
    (place.display_name ?? "").split(",").slice(0, 3).join(",").trim() ||
    undefined;

  const displayName =
    [city ?? locality, state].filter(Boolean).join(", ") ||
    (place.display_name ?? "").split(",").slice(0, 2).join(",").trim() ||
    "Unknown location";

  const lat = place.lat != null ? Number(place.lat) : undefined;
  const lon = place.lon != null ? Number(place.lon) : undefined;

  const out: ResolvedLocation = {
    displayName,
    provider: "nominatim",
    approximate: false,
  };
  if (Number.isFinite(lat)) out.latitude = lat;
  if (Number.isFinite(lon)) out.longitude = lon;
  if (addressLine) out.address = addressLine;
  if (locality) out.locality = locality;
  if (city) out.city = city;
  if (state) out.state = state;
  if (country) out.country = country;
  if (postalCode) out.postalCode = postalCode;
  return out;
}

async function nominatimFetch(path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`${env.nominatimBaseUrl}${path}`, {
    signal,
    headers: {
      // OSM's usage policy requires an identifying UA.
      "User-Agent": env.nominatimUserAgent,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new AppError("Geocoding service is unavailable right now", 502);
  }
  return res.json();
}

const nominatimProvider: GeoProvider = {
  name: "nominatim",

  async reverse(lat, lng, signal) {
    const qs = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      zoom: "16",
      lat: String(lat),
      lon: String(lng),
    });
    const data = (await nominatimFetch(`/reverse?${qs}`, signal)) as NominatimPlace & {
      error?: string;
    };
    if (!data || data.error || !data.address) {
      throw new AppError("Couldn't resolve that location", 404);
    }
    return toResolved(data);
  },

  async search(query, signal) {
    const qs = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      limit: "6",
      // Bias to India — the storefront ships within India — without hard
      // excluding, so an expat searching their home city still gets a hit.
      countrycodes: "in",
      q: query,
    });
    const data = (await nominatimFetch(`/search?${qs}`, signal)) as NominatimPlace[];
    if (!Array.isArray(data)) return [];
    return data.map(toResolved);
  },
};

// ---- Factory ---------------------------------------------------------------

export function getGeoProvider(): GeoProvider {
  switch (env.locationProvider) {
    case "nominatim":
      return nominatimProvider;
    case "google":
    case "mapbox":
      // Intentionally unimplemented — the seam is here, wire it up with the
      // key from env (googleMapsApiKey / mapboxToken) when needed.
      throw new AppError(
        `Location provider "${env.locationProvider}" is selected but not configured`,
        500
      );
    default:
      return nominatimProvider;
  }
}
