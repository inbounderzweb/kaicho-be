import sanitizeHtml from "sanitize-html";
import { sanitizeProductHtml } from "../product/product.sanitize";
import { htmlToPlainText } from "../blog/blog.sanitize";

// Page HTML and FAQ answers reuse the product-description allowlist: headings
// (h1 is downgraded to h2 — the page template owns the H1), paragraphs, lists,
// links (external ones get rel=noopener noreferrer nofollow + target=_blank),
// blockquote, code and tables. No script/style/iframe/form/img/event handlers,
// and only http/https/mailto URLs. Dropped, not rejected, so a paste degrades
// gracefully instead of failing the save.
export function sanitizePageHtml(html: string): string {
  return sanitizeProductHtml(html ?? "");
}

/** FAQ questions are plain text everywhere (accordion title + JSON-LD). */
export function sanitizeFaqQuestion(text: string): string {
  return sanitizeHtml(text ?? "", { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function isBlankHtml(html: string): boolean {
  return htmlToPlainText(html) === "";
}
