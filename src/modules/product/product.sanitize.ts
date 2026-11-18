import sanitizeHtml from "sanitize-html";
import { htmlToPlainText } from "../blog/blog.sanitize";

// The product description is admin-authored HTML from the rich-text editor,
// rendered with dangerouslySetInnerHTML on the storefront — so this allowlist
// is the only thing standing between an editor paste and the public page.
// Same drop-don't-reject policy as the blog (blog.sanitize.ts).
//
// Differences from the blog allowlist, on purpose:
//  - no <img>/<figure>: product images live in the gallery, and the Media
//    lifecycle (data-media-id attach/detach) is only wired for blog bodies —
//    an inline image here would be reclaimed by the TTL job after 24h.
//  - no <h1>: the product name owns the page's H1; any h1 becomes h2.
const ALLOWED_TAGS = [
  "h2", "h3", "h4", "p", "br", "hr",
  "strong", "em", "u", "s", "a",
  "ul", "ol", "li", "blockquote", "code", "pre",
  "table", "thead", "tbody", "tr", "th", "td",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "rel", "target"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    h1: "h2",
    a: (_tagName, attribs) => {
      const href = attribs.href ?? "";
      const external = href !== "" && !(href.startsWith("/") || href.startsWith("#"));
      return {
        tagName: "a",
        attribs: {
          ...attribs,
          ...(external
            ? { rel: "noopener noreferrer nofollow", target: "_blank" }
            : { rel: "noopener" }),
        },
      };
    },
  },
};

/** Sanitize admin-authored product description HTML down to the allowlist. */
export function sanitizeProductHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, OPTIONS);
}

/** True when the HTML has no visible text (e.g. the editor's empty "<p></p>"). */
export function isBlankHtml(html: string): boolean {
  return htmlToPlainText(html) === "";
}
