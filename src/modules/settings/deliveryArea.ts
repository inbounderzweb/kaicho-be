import { AppError } from "../../common/errors";
import { INDIAN_STATES, type IndianState } from "../../database/models";
import { getStoreSettingsDoc } from "./settings.service";

// Address `state` is free text, so "kerala", "KL" and "Kerala " must all count
// as Kerala. Anything we can't map to a known state is treated as NOT
// deliverable while a restriction is on (fail closed).

const key = (value: string): string =>
  value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const BY_KEY = new Map<string, IndianState>(INDIAN_STATES.map((s) => [key(s), s]));

const ALIASES: Record<string, IndianState> = {
  orissa: "Odisha",
  pondicherry: "Puducherry",
  uttaranchal: "Uttarakhand",
  "nct of delhi": "Delhi",
  "new delhi": "Delhi",
  "dadra and nagar haveli": "Dadra and Nagar Haveli and Daman and Diu",
  "daman and diu": "Dadra and Nagar Haveli and Daman and Diu",
  "andaman and nicobar": "Andaman and Nicobar Islands",
  // Two-letter codes people type into a state box.
  an: "Andaman and Nicobar Islands", ap: "Andhra Pradesh", ar: "Arunachal Pradesh", as: "Assam", br: "Bihar",
  ch: "Chandigarh", cg: "Chhattisgarh", dn: "Dadra and Nagar Haveli and Daman and Diu", dd: "Dadra and Nagar Haveli and Daman and Diu",
  dl: "Delhi", ga: "Goa", gj: "Gujarat", hr: "Haryana", hp: "Himachal Pradesh", jk: "Jammu and Kashmir", jh: "Jharkhand",
  ka: "Karnataka", kl: "Kerala", la: "Ladakh", ld: "Lakshadweep", mp: "Madhya Pradesh", mh: "Maharashtra", mn: "Manipur",
  ml: "Meghalaya", mz: "Mizoram", nl: "Nagaland", od: "Odisha", or: "Odisha", py: "Puducherry", pb: "Punjab", rj: "Rajasthan",
  sk: "Sikkim", tn: "Tamil Nadu", ts: "Telangana", tg: "Telangana", tr: "Tripura", up: "Uttar Pradesh", uk: "Uttarakhand",
  ut: "Uttarakhand", wb: "West Bengal",
};

/** Maps free-text state input to the canonical state name, or null if unknown. */
export function resolveIndianState(input: string | null | undefined): IndianState | null {
  if (!input) return null;
  const k = key(input);
  return BY_KEY.get(k) ?? ALIASES[k] ?? null;
}

export interface DeliveryAreaPolicy {
  restrictDeliveryToStates: boolean;
  serviceableStates: readonly string[];
}

/** Pure rule: is this state served under the given policy? */
export function isStateDeliverable(state: string | null | undefined, policy: DeliveryAreaPolicy): boolean {
  if (!policy.restrictDeliveryToStates) return true;
  const resolved = resolveIndianState(state);
  return resolved !== null && policy.serviceableStates.includes(resolved);
}

export function notServedMessage(state: string | null | undefined, policy: DeliveryAreaPolicy): string {
  const served = policy.serviceableStates;
  const where = served.length > 0 && served.length <= 5 ? `only to ${served.join(", ")}` : "only to selected states";
  const here = state?.trim() ? ` Your delivery address is in ${state.trim()}.` : "";
  return `Sorry, we currently deliver ${where}.${here}`;
}

/**
 * Throws a 422 when the store restricts delivery and this address's state is
 * outside the allowed list. Called by checkout BEFORE any stock, coupon or
 * order is touched. Reads the live setting, so an admin change applies to the
 * very next order.
 */
export async function assertStateDeliverable(state: string | null | undefined): Promise<void> {
  const doc = await getStoreSettingsDoc();
  const policy: DeliveryAreaPolicy = {
    restrictDeliveryToStates: doc.restrictDeliveryToStates === true,
    serviceableStates: doc.serviceableStates ?? [],
  };
  if (isStateDeliverable(state, policy)) return;
  throw new AppError(notServedMessage(state, policy), 422, true, { code: "DELIVERY_AREA_NOT_SERVED" });
}
