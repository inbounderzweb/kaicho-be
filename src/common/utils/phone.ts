// Indian mobile number validation/normalisation, shared by the inquiry forms
// (and available to anything else that needs it). Accepts what a real user
// types — spaces, dashes, parens, a leading +91 / 91 / 0 — and reduces it to
// the 10-digit core, which must start 6-9 (the valid Indian mobile range).

export function normalizeIndianMobile(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  let core = digits;
  if (core.length === 12 && core.startsWith("91")) core = core.slice(2);
  else if (core.length === 11 && core.startsWith("0")) core = core.slice(1);
  return /^[6-9]\d{9}$/.test(core) ? core : null;
}

export function isValidIndianMobile(raw: string): boolean {
  return normalizeIndianMobile(raw) !== null;
}

/** Canonical stored form, e.g. "+919876543210". Returns null if invalid. */
export function toE164IndianMobile(raw: string): string | null {
  const core = normalizeIndianMobile(raw);
  return core ? `+91${core}` : null;
}
