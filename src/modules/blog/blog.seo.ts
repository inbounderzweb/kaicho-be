// A lightweight, transparent SEO checklist — guidance only. It never blocks a
// save and makes no ranking promises; it just surfaces the well-known
// on-page basics (spec §9) as pass/fail data the admin UI renders. Kept on the
// backend so the same result feeds both the editor panel and the blog-list
// "SEO status" column/filter without the rules drifting between two places.

export interface SeoChecklistItem {
  key: string;
  label: string;
  passed: boolean;
}

export type SeoReadiness = "good" | "needs-work" | "poor";

export interface SeoChecklistResult {
  items: SeoChecklistItem[];
  passedCount: number;
  totalCount: number;
  /** Coarse bucket for the list badge. */
  readiness: SeoReadiness;
}

export interface SeoChecklistInput {
  title: string;
  slug: string;
  excerpt: string;
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  canonicalUrl?: string;
  contentHtml: string;
  hasFeaturedImage: boolean;
  featuredImageAlt?: string | null;
}

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function computeSeoChecklist(input: SeoChecklistInput): SeoChecklistResult {
  const keyword = (input.focusKeyword ?? "").trim();
  const effectiveTitle = (input.metaTitle || input.title || "").trim();
  const effectiveDescription = (input.metaDescription || input.excerpt || "").trim();
  const html = input.contentHtml || "";

  const items: SeoChecklistItem[] = [
    { key: "meta-title", label: "SEO title exists", passed: Boolean((input.metaTitle ?? "").trim()) },
    {
      key: "meta-description",
      label: "Meta description exists",
      passed: Boolean((input.metaDescription ?? "").trim()),
    },
    { key: "focus-keyword", label: "Focus keyword exists", passed: keyword.length > 0 },
    {
      key: "keyword-in-title",
      label: "Focus keyword appears in title",
      passed: keyword.length > 0 && includesCI(effectiveTitle, keyword),
    },
    {
      key: "keyword-in-slug",
      label: "Focus keyword appears in slug",
      passed: keyword.length > 0 && includesCI(input.slug, keyword.replace(/\s+/g, "-")),
    },
    {
      key: "keyword-in-description",
      label: "Focus keyword appears in description",
      passed: keyword.length > 0 && includesCI(effectiveDescription, keyword),
    },
    { key: "featured-image", label: "Featured image exists", passed: input.hasFeaturedImage },
    {
      key: "featured-image-alt",
      label: "Featured image has alt text",
      passed: input.hasFeaturedImage && Boolean((input.featuredImageAlt ?? "").trim()),
    },
    { key: "has-h2", label: "Content contains H2 sections", passed: /<h2[\s>]/i.test(html) },
    {
      key: "internal-link",
      label: "Internal link exists",
      passed: /<a\s[^>]*href=["'](\/|#)/i.test(html),
    },
    {
      key: "canonical",
      label: "Canonical URL configured",
      // Always true in practice — an explicit canonicalUrl, or the auto one
      // the public page emits from the slug. Surfaced so the admin sees it's
      // handled, not as a gap to fix.
      passed: true,
    },
  ];

  const passedCount = items.filter((i) => i.passed).length;
  const totalCount = items.length;
  const ratio = passedCount / totalCount;
  const readiness: SeoReadiness = ratio >= 0.8 ? "good" : ratio >= 0.5 ? "needs-work" : "poor";

  return { items, passedCount, totalCount, readiness };
}
