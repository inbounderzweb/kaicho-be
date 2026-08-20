// Shared slug normalization used by every module that owns a `slug` field
// (Category, Brand, Product). Normalizes any input -- an auto-generated slug
// from a name, or a client-supplied slug -- into the same URL-safe shape.
// Never trust raw client text directly; both paths go through this.
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
}
