import sanitizeHtml from "sanitize-html";

// The blog body is admin-authored HTML coming out of a rich-text editor. It is
// still untrusted input the moment it crosses the API boundary — nothing else
// in this codebase renders admin HTML, so this allowlist is the single place
// that decides what a blog post is allowed to contain. Everything not listed
// is dropped (tags unwrapped, attributes stripped) rather than rejected, so a
// paste from Word/Docs degrades gracefully instead of erroring the save.

// Block/inline structure a long-form article legitimately needs. Note the
// absence of h1: the post title owns the page's single H1, so any h1 in the
// body is downgraded to h2 below (see transformTags) to keep the outline
// valid for SEO.
const ALLOWED_TAGS = [
  "h2",
  "h3",
  "h4",
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "u",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("#");
}

export const BLOG_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "rel", "target"],
    // data-media-id ties a body <img> back to its Media doc so blog.service.ts
    // can attach/detach it through the same lifecycle as the featured image
    // (otherwise the TTL cleanup job would reclaim it after 24h). Inert in the
    // browser; kept in the stored/served HTML on purpose.
    img: ["src", "alt", "title", "width", "height", "loading", "data-media-id"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    // Heading ids are injected server-side by blog.content.ts, never trusted
    // from the editor — so `id` is intentionally NOT allowed here.
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowProtocolRelative: false,
  // Drop the whole <img> if a data: URI is anything other than an image.
  exclusiveFilter: (frame) =>
    frame.tag === "img" &&
    typeof frame.attribs.src === "string" &&
    frame.attribs.src.startsWith("data:") &&
    !frame.attribs.src.startsWith("data:image/"),
  transformTags: {
    // Keep the article outline single-H1: any body h1 becomes h2.
    h1: "h2",
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const external = href !== "" && !isInternalHref(href);
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

/** Sanitize admin-authored blog HTML down to the allowlist above. */
export function sanitizeBlogHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, BLOG_SANITIZE_OPTIONS);
}

/** Plain text of a blog body — used for $text search and reading-time. */
export function htmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}
