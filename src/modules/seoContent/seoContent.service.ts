import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Category,
  PageContent,
  PageContentDocument,
  Product,
  STATIC_PAGE_TYPES,
  type PageType,
  type StaticPageType,
  type EntityPageType,
} from "../../database/models";
import { attachMediaToEntity, detachMedia, getMediaDocById } from "../media/media.service";
import { getStorageProvider } from "../media/storage";
import { sanitizePageHtml, sanitizeFaqQuestion, isBlankHtml } from "./seoContent.sanitize";
import type { SavePageContentInput } from "./seoContent.validation";

const storage = getStorageProvider();

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const STATIC_PAGE_LABELS: Record<StaticPageType, { label: string; path: string }> = {
  HOME: { label: "Home Page", path: "/" },
  ABOUT: { label: "About Us", path: "/about" },
  CONTACT: { label: "Contact Us", path: "/contact" },
  ALL_PRODUCTS: { label: "All Products", path: "/products" },
  B2B: { label: "B2B / Bulk Orders", path: "/b2b" },
};

// ---- DTO ----

export interface PageContentDto {
  pageType: PageType;
  entityId: string | null;
  seo: {
    title: string;
    description: string;
    keywords: string[];
    canonicalUrl: string;
    ogTitle: string;
    ogDescription: string;
    ogImageMediaId: string | null;
    ogImageUrl: string | null;
    robotsIndex: boolean;
    robotsFollow: boolean;
  };
  htmlContent: string;
  faqEnabled: boolean;
  faqs: { id: string; question: string; answer: string }[];
  updatedAt: string | null;
}

type SeoLike = {
  title?: string;
  description?: string;
  keywords?: string[];
  canonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageMediaId?: mongoose.Types.ObjectId | null;
  robotsIndex?: boolean;
  robotsFollow?: boolean;
};

async function ogUrl(id?: mongoose.Types.ObjectId | null): Promise<string | null> {
  if (!id) return null;
  const media = await getMediaDocById(id.toString());
  if (!media) return null;
  const key = media.variants ? media.variants.optimized.key : media.storageKey;
  return storage.getUrl(key);
}

async function toSeoDto(seo: SeoLike | undefined): Promise<PageContentDto["seo"]> {
  return {
    title: seo?.title ?? "",
    description: seo?.description ?? "",
    keywords: seo?.keywords ?? [],
    canonicalUrl: seo?.canonicalUrl ?? "",
    ogTitle: seo?.ogTitle ?? "",
    ogDescription: seo?.ogDescription ?? "",
    ogImageMediaId: seo?.ogImageMediaId ? seo.ogImageMediaId.toString() : null,
    ogImageUrl: await ogUrl(seo?.ogImageMediaId),
    robotsIndex: seo?.robotsIndex ?? true,
    robotsFollow: seo?.robotsFollow ?? true,
  };
}

async function toDto(
  pageType: PageType,
  entityId: string | null,
  content: PageContentDocument | null,
  seoSource: SeoLike | undefined
): Promise<PageContentDto> {
  return {
    pageType,
    entityId,
    seo: await toSeoDto(seoSource),
    htmlContent: content?.htmlContent ?? "",
    faqEnabled: content?.faqEnabled ?? false,
    faqs: (content?.faqs ?? []).map((f) => ({ id: f._id.toString(), question: f.question, answer: f.answer })),
    updatedAt: content?.updatedAt ? content.updatedAt.toISOString() : null,
  };
}

// ---- Resolution ----

async function requireEntity(pageType: EntityPageType, entityId: string) {
  if (!isValidObjectId(entityId)) throw new AppError("Invalid id", 400);
  const exists =
    pageType === "PRODUCT"
      ? await Product.exists({ _id: entityId })
      : await Category.exists({ _id: entityId });
  if (!exists) throw new AppError(`${pageType === "PRODUCT" ? "Product" : "Category"} not found`, 404);
}

function contentFilter(pageType: PageType, entityId: string | null) {
  return entityId
    ? { pageType, entityId: new mongoose.Types.ObjectId(entityId) }
    : { pageType, entityId: { $exists: false } };
}

// ---- Admin read ----

export async function getPageContent(pageType: PageType, entityId: string | null): Promise<PageContentDto> {
  if (entityId) await requireEntity(pageType as EntityPageType, entityId);
  const content = await PageContent.findOne(contentFilter(pageType, entityId)).exec();
  if (pageType === "PRODUCT") {
    const product = await Product.findById(entityId).select("seo").lean().exec();
    return toDto(pageType, entityId, content, product?.seo as SeoLike | undefined);
  }
  return toDto(pageType, entityId, content, content?.seo);
}

export async function listStaticPages() {
  const rows = await PageContent.find({ pageType: { $in: STATIC_PAGE_TYPES } })
    .select("pageType seo.title htmlContent faqEnabled faqs updatedAt")
    .lean()
    .exec();
  const byType = new Map(rows.map((r) => [r.pageType, r]));
  return STATIC_PAGE_TYPES.map((pageType) => {
    const row = byType.get(pageType);
    return {
      pageType,
      ...STATIC_PAGE_LABELS[pageType],
      hasSeo: Boolean(row?.seo?.title),
      hasHtml: Boolean(row?.htmlContent),
      faqEnabled: row?.faqEnabled ?? false,
      faqCount: row?.faqs?.length ?? 0,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
}

export async function listEntities(pageType: EntityPageType, opts: { search?: unknown; limit?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const search = typeof opts.search === "string" ? opts.search.trim() : "";
  const filter: Record<string, unknown> = {};
  if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
  const Model = pageType === "PRODUCT" ? Product : Category;
  const docs = await (Model as typeof Product)
    .find(filter)
    .select("name slug")
    .sort({ name: 1 })
    .limit(limit)
    .lean()
    .exec();
  const ids = docs.map((d) => d._id);
  const configured = await PageContent.find({ pageType, entityId: { $in: ids } })
    .select("entityId faqEnabled faqs htmlContent")
    .lean()
    .exec();
  const cfg = new Map(configured.map((c) => [c.entityId!.toString(), c]));
  return docs.map((d) => {
    const c = cfg.get(d._id.toString());
    return {
      id: d._id.toString(),
      name: d.name,
      slug: d.slug,
      faqEnabled: c?.faqEnabled ?? false,
      faqCount: c?.faqs?.length ?? 0,
      hasHtml: Boolean(c?.htmlContent),
    };
  });
}

// ---- Admin write ----

function buildFaqs(input: SavePageContentInput["faqs"]) {
  return input
    .map((f) => ({ question: sanitizeFaqQuestion(f.question), answer: sanitizePageHtml(f.answer) }))
    .filter((f) => f.question !== "" && !isBlankHtml(f.answer));
}

export async function savePageContent(
  pageType: PageType,
  entityId: string | null,
  input: SavePageContentInput,
  actorId?: string
): Promise<PageContentDto> {
  if (entityId) await requireEntity(pageType as EntityPageType, entityId);

  const ogRaw = input.seo.ogImageMediaId || undefined;
  if (ogRaw) {
    const media = await getMediaDocById(ogRaw);
    if (!media) throw new AppError("OG image media not found", 400);
    if (media.mediaType !== "IMAGE") throw new AppError("OG image must be an image", 400);
  }

  const htmlContent = sanitizePageHtml(input.htmlContent);
  const faqs = buildFaqs(input.faqs);
  const set: Record<string, unknown> = {
    htmlContent: isBlankHtml(htmlContent) ? "" : htmlContent,
    faqEnabled: input.faqEnabled,
    faqs,
  };
  if (actorId && isValidObjectId(actorId)) set.updatedBy = new mongoose.Types.ObjectId(actorId);

  const seoFields = {
    title: input.seo.title,
    description: input.seo.description,
    keywords: input.seo.keywords,
    canonicalUrl: input.seo.canonicalUrl || undefined,
    ogTitle: input.seo.ogTitle || undefined,
    ogDescription: input.seo.ogDescription || undefined,
    ogImageMediaId: ogRaw ? new mongoose.Types.ObjectId(ogRaw) : undefined,
    robotsIndex: input.seo.robotsIndex,
    robotsFollow: input.seo.robotsFollow,
  };

  // Previous OG image, for attach/detach bookkeeping.
  let previousOg: string | undefined;

  if (pageType === "PRODUCT") {
    // Product SEO lives on Product.seo — write it there, never a second copy.
    const product = await Product.findById(entityId).exec();
    if (!product) throw new AppError("Product not found", 404);
    previousOg = product.seo.ogImageMediaId?.toString();
    product.seo.title = seoFields.title;
    product.seo.description = seoFields.description;
    product.seo.keywords = seoFields.keywords;
    product.seo.canonicalUrl = seoFields.canonicalUrl;
    product.seo.ogTitle = seoFields.ogTitle;
    product.seo.ogDescription = seoFields.ogDescription;
    product.seo.ogImageMediaId = seoFields.ogImageMediaId;
    product.seo.robotsIndex = seoFields.robotsIndex;
    product.seo.robotsFollow = seoFields.robotsFollow;
    await product.save();
  } else {
    const existing = await PageContent.findOne(contentFilter(pageType, entityId)).select("seo").lean().exec();
    previousOg = existing?.seo?.ogImageMediaId?.toString();
    set.seo = seoFields;
  }

  const doc = await PageContent.findOneAndUpdate(
    contentFilter(pageType, entityId),
    { $set: set, $setOnInsert: { pageType, ...(entityId ? { entityId } : {}) } },
    { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true }
  ).exec();

  // OG image lifecycle (otherwise the Media TTL job reclaims it).
  const owner = ogOwner(pageType, entityId, doc._id.toString());
  if (ogRaw !== previousOg) {
    if (ogRaw) await attachMediaToEntity(ogRaw, owner.type, owner.id, { field: "og" });
    if (previousOg) await detachMedia(previousOg, { entityType: owner.type, entityId: owner.id, field: "og" });
  }

  return getPageContent(pageType, entityId);
}

function ogOwner(pageType: PageType, entityId: string | null, docId: string) {
  if (pageType === "PRODUCT") return { type: "PRODUCT" as const, id: entityId! };
  if (pageType === "CATEGORY") return { type: "CATEGORY" as const, id: entityId! };
  return { type: "BANNER" as const, id: docId };
}

// ---- Public ----

/** Resolve a public slug to the entity id for PRODUCT / CATEGORY. */
async function resolveSlug(pageType: EntityPageType, slug: string): Promise<string | null> {
  // Only what the storefront itself would show: DRAFT/ARCHIVED products and
  // inactive categories 404 here, so their SEO/FAQ never leaks.
  const doc =
    pageType === "PRODUCT"
      ? await Product.findOne({ slug, status: { $in: ["ACTIVE", "OUT_OF_STOCK"] } }).select("_id").lean().exec()
      : await Category.findOne({ slug, isActive: true }).select("_id").lean().exec();
  return doc ? doc._id.toString() : null;
}

/**
 * Public payload. FAQs are only returned when enabled. A missing document is
 * a normal "nothing configured" response (200 + empty), so the storefront
 * falls back to its built-in metadata.
 */
export async function getPublicPageContent(pageType: PageType, slug?: string) {
  let entityId: string | null = null;
  if (pageType === "PRODUCT" || pageType === "CATEGORY") {
    if (!slug) throw new AppError("slug is required", 400);
    entityId = await resolveSlug(pageType, slug);
    if (!entityId) throw new AppError("Not found", 404);
  }
  const dto = await getPageContent(pageType, entityId);
  return {
    seo: dto.seo,
    htmlContent: dto.htmlContent,
    faq: {
      enabled: dto.faqEnabled && dto.faqs.length > 0,
      items: dto.faqEnabled ? dto.faqs : [],
    },
  };
}
