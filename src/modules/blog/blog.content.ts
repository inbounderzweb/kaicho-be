import { slugify } from "../../common/utils/slugify";
import { htmlToPlainText } from "./blog.sanitize";
import type { BlogTocItem } from "../../database/models";

const WORDS_PER_MINUTE = 200;

export interface DerivedContentMeta {
  /** contentHtml with stable, de-duplicated ids injected into h2/h3. */
  contentHtml: string;
  contentText: string;
  readingTimeMinutes: number;
  tableOfContents: BlogTocItem[];
}

function stripInlineTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Runs over the ALREADY-SANITIZED body (see blog.sanitize.ts, which normalizes
 * headings to bare lowercase <h2>/<h3> with no attributes), so a regex pass is
 * safe here — no arbitrary attribute soup to contend with. It injects a
 * heading id derived from the visible text (deduped with -2, -3 … suffixes so
 * two "Benefits" sections get distinct anchors) and builds the TOC in document
 * order. The ids are what BlogToc.tsx scrolls to on the public page.
 */
export function deriveContentMeta(sanitizedHtml: string): DerivedContentMeta {
  const contentText = htmlToPlainText(sanitizedHtml);

  const words = contentText ? contentText.split(/\s+/).filter(Boolean).length : 0;
  const readingTimeMinutes = words > 0 ? Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) : 0;

  const usedIds = new Map<string, number>();
  const tableOfContents: BlogTocItem[] = [];

  const contentHtml = sanitizedHtml.replace(
    /<(h2|h3)>([\s\S]*?)<\/\1>/g,
    (_full, tag: string, inner: string) => {
      const text = stripInlineTags(inner);
      if (!text) return `<${tag}>${inner}</${tag}>`;

      const base = slugify(text) || "section";
      const seen = usedIds.get(base) ?? 0;
      usedIds.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen + 1}`;

      tableOfContents.push({ id, text, level: tag === "h2" ? 2 : 3 });
      return `<${tag} id="${id}">${inner}</${tag}>`;
    }
  );

  return { contentHtml, contentText, readingTimeMinutes, tableOfContents };
}

/** Word count helper reused by the SEO checklist ("content has enough body"). */
export function countWords(plainText: string): number {
  return plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
}
