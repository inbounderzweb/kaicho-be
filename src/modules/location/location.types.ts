// The single normalized shape every /api/location/* endpoint returns. Only
// fields the selected provider actually gave us are populated — undefined
// keys are omitted by the controller's JSON serialization. `approximate` is
// true for the IP-based fallback so the client can label it as such.
export interface ResolvedLocation {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  address?: string;
  locality?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  /** Short human label, e.g. "Bengaluru, Karnataka". Always present. */
  displayName: string;
  provider: "nominatim" | "ipapi" | "google" | "mapbox";
  approximate: boolean;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  pincode?: string;
  /** User-facing, non-technical. */
  note: string;
}
