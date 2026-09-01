import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Blog,
  BlogCategory,
  BlogDocument,
  BlogTag,
  BLOG_STATUS_TRANSITIONS,
  User,
  type BlogStatus,
} from "../../database/models";
import { slugify } from "../../common/utils/slugify";
import { sanitizeBlogHtml } from "./blog.sanitize";
import { deriveContentMeta } from "./blog.content";
import { computeSeoChecklist, type SeoChecklistResult } from "./blog.seo";
import {
  assertImageMedia,
  extractBodyMediaIds,
  resolveBlogImage,
  resolveBlogImages,
  syncEntityMedia,
  detachAllEntityMedia,
  type BlogImage,
} from "./blog.media";
import { resolveTagIds } from "./blogTag.service";
import type { CreateBlogInput, UpdateBlogInput } from "./blog.validation";

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "Published and actually live" — status alone isn't enough; a post could in
// principle carry a future publishedAt. Every public read funnels through this.
function publicMatch(): Record<string, unknown> {
  return { status: "PUBLISHED", publishedAt: { $lte: new Date() } };
}

// ---------------------------------------------------------------------------
// Slug resolution
// ---------------------------------------------------------------------------

async function assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
  const clash = await Blog.findOne({
    $or: [{ slug }, { previousSlugs: slug }],
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("_id")
    .lean();
  if (clash) {
    throw new AppError("That slug is already in use (or was previously used) by another post", 409);
  }
}

async function uniquify(baseSlug: string): Promise<string> {
  let candidate = baseSlug;
  let n = 2;
  // Bounded: a handful of "-copy", "-copy-2" collisions is realistic, hundreds
  // is not — fail loudly rather than loop forever.
  while (n < 100) {
    const exists = await Blog.findOne({ $or: [{ slug: candidate }, { previousSlugs: candidate }] })
      .select("_id")
      .lean();
    if (!exists) return candidate;
    candidate = `${baseSlug}-${n}`;
    n += 1;
  }
  throw new AppError("Could not derive a unique slug", 409);
}

// ---------------------------------------------------------------------------
// Content + SEO derivation (shared by create and update)
// ---------------------------------------------------------------------------

interface ContentDerived {
  contentHtml: string;
  contentText: string;
  readingTimeMinutes: number;
  tableOfContents: BlogDocument["tableOfContents"];
}

function deriveFromRawHtml(rawHtml: string | undefined): ContentDerived {
  const sanitized = sanitizeBlogHtml(rawHtml ?? "");
  const meta = deriveContentMeta(sanitized);
  return {
    contentHtml: meta.contentHtml,
    contentText: meta.contentText,
    readingTimeMinutes: meta.readingTimeMinutes,
    tableOfContents: meta.tableOfContents as BlogDocument["tableOfContents"],
  };
}

async function recomputeSeo(doc: BlogDocument): Promise<SeoChecklistResult> {
  const featured = await resolveBlogImage(doc.featuredImageMediaId);
  const result = computeSeoChecklist({
    title: doc.title,
    slug: doc.slug,
    excerpt: doc.excerpt,
    metaTitle: doc.seo?.metaTitle,
    metaDescription: doc.seo?.metaDescription,
    focusKeyword: doc.seo?.focusKeyword,
    canonicalUrl: doc.seo?.canonicalUrl,
    contentHtml: doc.contentHtml,
    hasFeaturedImage: Boolean(doc.featuredImageMediaId),
    featuredImageAlt: featured?.altText ?? null,
  });
  doc.seoReadiness = result.readiness;
  doc.seoScore = Math.round((result.passedCount / result.totalCount) * 100);
  return result;
}

// Every media id a blog write can reference — featured, thumbnail, OG, and
// every inline body image marked with data-media-id.
function collectMediaIds(doc: BlogDocument): string[] {
  const ids: string[] = [];
  if (doc.featuredImageMediaId) ids.push(doc.featuredImageMediaId.toString());
  if (doc.thumbnailImageMediaId) ids.push(doc.thumbnailImageMediaId.toString());
  if (doc.seo?.ogImageMediaId) ids.push(doc.seo.ogImageMediaId.toString());
  ids.push(...extractBodyMediaIds(doc.contentHtml || ""));
  return [...new Set(ids.map((i) => i.toLowerCase()))];
}

// ---------------------------------------------------------------------------
// DTO shaping
// ---------------------------------------------------------------------------

interface RefLookups {
  authors: Map<string, { userId: string; name: string; avatar: string | null }>;
  categories: Map<string, { categoryId: string; name: string; slug: string }>;
  tags: Map<string, { tagId: string; name: string; slug: string }>;
  images: Map<string, BlogImage>;
}

function resolveAuthorName(doc: BlogDocument, refs: RefLookups): { name: string; avatar: string | null } | null {
  if (doc.authorName && doc.authorName.trim()) {
    return { name: doc.authorName.trim(), avatar: null };
  }
  if (doc.author) {
    return refs.authors.get(doc.author.toString()) ?? null;
  }
  return null;
}

async function buildLookups(docs: BlogDocument[]): Promise<RefLookups> {
  const authorIds = [...new Set(docs.map((d) => d.author?.toString()).filter(Boolean))] as string[];
  const categoryIds = [...new Set(docs.map((d) => d.categoryId?.toString()).filter(Boolean))] as string[];
  const tagIds = [...new Set(docs.flatMap((d) => (d.tagIds ?? []).map((t) => t.toString())))];
  const imageIds = docs.flatMap((d) => [
    d.featuredImageMediaId,
    d.thumbnailImageMediaId,
    d.seo?.ogImageMediaId,
  ]);

  const [authorDocs, categoryDocs, tagDocs, images] = await Promise.all([
    authorIds.length ? User.find({ _id: { $in: authorIds } }).select("firstName lastName avatar").lean() : [],
    categoryIds.length ? BlogCategory.find({ _id: { $in: categoryIds } }).select("name slug").lean() : [],
    tagIds.length ? BlogTag.find({ _id: { $in: tagIds } }).select("name slug").lean() : [],
    resolveBlogImages(imageIds),
  ]);

  return {
    authors: new Map(
      authorDocs.map((u: any) => [
        u._id.toString(),
        {
          userId: u._id.toString(),
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "Kaicho Team",
          avatar: u.avatar ?? null,
        },
      ])
    ),
    categories: new Map(
      categoryDocs.map((c: any) => [c._id.toString(), { categoryId: c._id.toString(), name: c.name, slug: c.slug }])
    ),
    tags: new Map(
      tagDocs.map((t: any) => [t._id.toString(), { tagId: t._id.toString(), name: t.name, slug: t.slug }])
    ),
    images,
  };
}

function shapeBlogAdmin(doc: BlogDocument, refs: RefLookups, seoChecklist: SeoChecklistResult | null) {
  return {
    blogId: doc._id.toString(),
    title: doc.title,
    slug: doc.slug,
    previousSlugs: doc.previousSlugs ?? [],
    excerpt: doc.excerpt,
    contentHtml: doc.contentHtml,
    author: resolveAuthorName(doc, refs),
    category: refs.categories.get(doc.categoryId?.toString() ?? "") ?? null,
    tags: (doc.tagIds ?? []).map((t) => refs.tags.get(t.toString())).filter(Boolean),
    status: doc.status,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    scheduledFor: doc.scheduledFor ? doc.scheduledFor.toISOString() : null,
    statusHistory: (doc.statusHistory ?? []).map((h) => ({
      status: h.status,
      at: h.at.toISOString(),
      byUserId: h.byUserId ? h.byUserId.toString() : null,
      note: h.note ?? null,
    })),
    featuredImage: doc.featuredImageMediaId
      ? refs.images.get(doc.featuredImageMediaId.toString()) ?? null
      : null,
    thumbnailImage: doc.thumbnailImageMediaId
      ? refs.images.get(doc.thumbnailImageMediaId.toString()) ?? null
      : null,
    seo: {
      metaTitle: doc.seo?.metaTitle ?? "",
      metaDescription: doc.seo?.metaDescription ?? "",
      focusKeyword: doc.seo?.focusKeyword ?? "",
      canonicalUrl: doc.seo?.canonicalUrl ?? "",
      ogTitle: doc.seo?.ogTitle ?? "",
      ogDescription: doc.seo?.ogDescription ?? "",
      ogImage: doc.seo?.ogImageMediaId ? refs.images.get(doc.seo.ogImageMediaId.toString()) ?? null : null,
      noIndex: Boolean(doc.seo?.noIndex),
      noFollow: Boolean(doc.seo?.noFollow),
    },
    readingTimeMinutes: doc.readingTimeMinutes,
    tableOfContents: doc.tableOfContents ?? [],
    schemaEnabled: doc.schemaEnabled,
    faqs: doc.faqs ?? [],
    relatedBlogIds: (doc.relatedBlogIds ?? []).map((r) => r.toString()),
    seoReadiness: doc.seoReadiness,
    seoScore: doc.seoScore,
    seoChecklist,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function shapeBlogPublicListItem(doc: BlogDocument, refs: RefLookups) {
  return {
    blogId: doc._id.toString(),
    title: doc.title,
    slug: doc.slug,
    excerpt: doc.excerpt,
    category: refs.categories.get(doc.categoryId?.toString() ?? "") ?? null,
    author: resolveAuthorName(doc, refs),
    image:
      (doc.thumbnailImageMediaId && refs.images.get(doc.thumbnailImageMediaId.toString())) ||
      (doc.featuredImageMediaId && refs.images.get(doc.featuredImageMediaId.toString())) ||
      null,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    readingTimeMinutes: doc.readingTimeMinutes,
  };
}

function shapeBlogPublicDetail(doc: BlogDocument, refs: RefLookups) {
  const featured = doc.featuredImageMediaId ? refs.images.get(doc.featuredImageMediaId.toString()) ?? null : null;
  return {
    blogId: doc._id.toString(),
    title: doc.title,
    slug: doc.slug,
    excerpt: doc.excerpt,
    contentHtml: doc.contentHtml,
    category: refs.categories.get(doc.categoryId?.toString() ?? "") ?? null,
    author: resolveAuthorName(doc, refs),
    tags: (doc.tagIds ?? []).map((t) => refs.tags.get(t.toString())).filter(Boolean),
    featuredImage: featured,
    readingTimeMinutes: doc.readingTimeMinutes,
    tableOfContents: doc.tableOfContents ?? [],
    faqs: doc.faqs ?? [],
    schemaEnabled: doc.schemaEnabled,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    updatedAt: doc.updatedAt.toISOString(),
    seo: {
      metaTitle: doc.seo?.metaTitle ?? "",
      metaDescription: doc.seo?.metaDescription ?? "",
      canonicalUrl: doc.seo?.canonicalUrl ?? "",
      ogTitle: doc.seo?.ogTitle ?? "",
      ogDescription: doc.seo?.ogDescription ?? "",
      ogImage: doc.seo?.ogImageMediaId ? refs.images.get(doc.seo.ogImageMediaId.toString()) ?? null : null,
      noIndex: Boolean(doc.seo?.noIndex),
      noFollow: Boolean(doc.seo?.noFollow),
    },
  };
}

// ---------------------------------------------------------------------------
// Admin: read
// ---------------------------------------------------------------------------

const ADMIN_SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  updated: { updatedAt: -1 },
  "title-asc": { title: 1 },
  "title-desc": { title: -1 },
};

export async function listBlogsAdmin(params: {
  page: number;
  pageSize: number;
  status?: unknown;
  categoryId?: unknown;
  author?: unknown;
  tag?: unknown;
  seoStatus?: unknown;
  search?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  sort?: unknown;
}) {
  const filter: Record<string, unknown> = {};

  if (typeof params.status === "string" && ["DRAFT", "SCHEDULED", "PUBLISHED", "ARCHIVED"].includes(params.status)) {
    filter.status = params.status as BlogStatus;
  }
  if (typeof params.categoryId === "string" && isValidObjectId(params.categoryId)) {
    filter.categoryId = new mongoose.Types.ObjectId(params.categoryId);
  }
  if (typeof params.author === "string" && isValidObjectId(params.author)) {
    filter.author = new mongoose.Types.ObjectId(params.author);
  }
  if (typeof params.tag === "string" && params.tag.trim()) {
    const tagDoc = await BlogTag.findOne({
      $or: [
        ...(isValidObjectId(params.tag) ? [{ _id: params.tag }] : []),
        { slug: slugify(params.tag) },
      ],
    })
      .select("_id")
      .lean();
    // Unknown tag -> deliberately match nothing rather than ignoring the filter.
    filter.tagIds = tagDoc ? tagDoc._id : new mongoose.Types.ObjectId();
  }
  if (typeof params.seoStatus === "string" && ["good", "needs-work", "poor"].includes(params.seoStatus)) {
    filter.seoReadiness = params.seoStatus;
  }
  if (typeof params.search === "string" && params.search.trim()) {
    const rx = new RegExp(escapeRegex(params.search.trim()), "i");
    filter.$or = [{ title: rx }, { slug: rx }, { excerpt: rx }];
  }
  const dateRange: Record<string, Date> = {};
  if (typeof params.dateFrom === "string" && !Number.isNaN(Date.parse(params.dateFrom))) {
    dateRange.$gte = new Date(params.dateFrom);
  }
  if (typeof params.dateTo === "string" && !Number.isNaN(Date.parse(params.dateTo))) {
    dateRange.$lte = new Date(params.dateTo);
  }
  if (Object.keys(dateRange).length) filter.updatedAt = dateRange;

  const sort = ADMIN_SORTS[String(params.sort ?? "")] ?? ADMIN_SORTS.updated;

  const [docs, total] = await Promise.all([
    Blog.find(filter)
      .sort(sort)
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      // contentHtml is large and unused by the list — leave it out.
      .select("-contentHtml -contentText")
      .exec(),
    Blog.countDocuments(filter),
  ]);

  const refs = await buildLookups(docs as unknown as BlogDocument[]);
  const items = (docs as unknown as BlogDocument[]).map((doc) => ({
    blogId: doc._id.toString(),
    title: doc.title,
    slug: doc.slug,
    status: doc.status,
    category: refs.categories.get(doc.categoryId?.toString() ?? "") ?? null,
    author: refs.authors.get(doc.author?.toString() ?? "") ?? null,
    thumbnailImage:
      (doc.thumbnailImageMediaId && refs.images.get(doc.thumbnailImageMediaId.toString())) ||
      (doc.featuredImageMediaId && refs.images.get(doc.featuredImageMediaId.toString())) ||
      null,
    tagCount: (doc.tagIds ?? []).length,
    seoReadiness: doc.seoReadiness,
    seoScore: doc.seoScore,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    scheduledFor: doc.scheduledFor ? doc.scheduledFor.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));

  return { items, page: params.page, pageSize: params.pageSize, total };
}

export async function getBlogAdmin(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Blog.findById(id).exec();
  if (!doc) return null;
  const refs = await buildLookups([doc]);
  const seoChecklist = await recomputeSeo(doc); // recompute for the live panel; not persisted here
  return shapeBlogAdmin(doc, refs, seoChecklist);
}

// ---------------------------------------------------------------------------
// Admin: write
// ---------------------------------------------------------------------------

export async function createBlog(input: CreateBlogInput, actorId?: string) {
  const [category, author] = await Promise.all([
    BlogCategory.findById(input.categoryId).select("_id").lean(),
    input.author ? User.findById(input.author).select("_id role").lean() : Promise.resolve(null),
  ]);
  if (!category) throw new AppError("Selected blog category does not exist", 400);
  if (input.author && (!author || (author as any).role !== "admin")) throw new AppError("Author must be an admin user", 400);

  const baseSlug = slugify(input.slug || input.title);
  if (!baseSlug) throw new AppError("Could not derive a valid slug from the title", 400);
  const slug = await uniquify(baseSlug);

  const tagIds = await resolveTagIds(input.tags);
  const content = deriveFromRawHtml(input.contentHtml);

  if (input.featuredImageMediaId) await assertImageMedia(input.featuredImageMediaId);
  if (input.thumbnailImageMediaId) await assertImageMedia(input.thumbnailImageMediaId);
  if (input.seo?.ogImageMediaId) await assertImageMedia(input.seo.ogImageMediaId);

  const now = new Date();
  const doc = new Blog({
    title: input.title.trim(),
    slug,
    excerpt: input.excerpt.trim(),
    contentHtml: content.contentHtml,
    contentText: content.contentText,
    readingTimeMinutes: content.readingTimeMinutes,
    tableOfContents: content.tableOfContents,
    featuredImageMediaId: input.featuredImageMediaId || undefined,
    thumbnailImageMediaId: input.thumbnailImageMediaId || undefined,
    author: input.author ? new mongoose.Types.ObjectId(input.author) : undefined,
    authorName: input.authorName?.trim() || undefined,
    categoryId: new mongoose.Types.ObjectId(input.categoryId),
    tagIds,
    status: "DRAFT",
    statusHistory: [{ status: "DRAFT", at: now, byUserId: actorId ? new mongoose.Types.ObjectId(actorId) : undefined }],
    seo: {
      metaTitle: input.seo?.metaTitle?.trim() || undefined,
      metaDescription: input.seo?.metaDescription?.trim() || undefined,
      focusKeyword: input.seo?.focusKeyword?.trim() || undefined,
      canonicalUrl: input.seo?.canonicalUrl?.trim() || undefined,
      ogTitle: input.seo?.ogTitle?.trim() || undefined,
      ogDescription: input.seo?.ogDescription?.trim() || undefined,
      ogImageMediaId: input.seo?.ogImageMediaId || undefined,
      noIndex: input.seo?.noIndex ?? false,
      noFollow: input.seo?.noFollow ?? false,
    },
    schemaEnabled: input.schemaEnabled ?? true,
    faqs: input.faqs ?? [],
    relatedBlogIds: (input.relatedBlogIds ?? []).map((r) => new mongoose.Types.ObjectId(r)),
    createdBy: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
    updatedBy: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
  });

  await recomputeSeo(doc);
  await doc.save();

  // If media attachment fails (e.g. an image already belongs to another
  // entity), don't leave a half-created post behind — same cleanup-on-failure
  // discipline as media.service.ts's processOneFile.
  try {
    await syncEntityMedia({
      entityType: "BLOG",
      entityId: doc._id.toString(),
      nextIds: collectMediaIds(doc),
      prevIds: [],
    });
  } catch (err) {
    await doc.deleteOne().catch(() => undefined);
    throw err;
  }

  return getBlogAdmin(doc._id.toString());
}

export async function updateBlog(id: string, patch: UpdateBlogInput, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Blog.findById(id).exec();
  if (!doc) return null;

  const prevMediaIds = collectMediaIds(doc);

  if (patch.categoryId !== undefined) {
    const category = await BlogCategory.findById(patch.categoryId).select("_id").lean();
    if (!category) throw new AppError("Selected blog category does not exist", 400);
    doc.categoryId = new mongoose.Types.ObjectId(patch.categoryId);
  }
  if (patch.author !== undefined) {
    if (patch.author) {
      const author = await User.findById(patch.author).select("_id role").lean();
      if (!author || (author as any).role !== "admin") throw new AppError("Author must be an admin user", 400);
      doc.author = new mongoose.Types.ObjectId(patch.author);
      doc.authorName = undefined;
    } else {
      doc.author = undefined;
    }
  }
  if (patch.authorName !== undefined) {
    doc.authorName = patch.authorName.trim() || undefined;
    if (doc.authorName) doc.author = undefined;
  }
  if (patch.title !== undefined) doc.title = patch.title.trim();
  if (patch.excerpt !== undefined) doc.excerpt = patch.excerpt.trim();

  if (patch.slug !== undefined || patch.title !== undefined) {
    const desired = slugify(patch.slug || doc.slug || doc.title);
    if (!desired) throw new AppError("Could not derive a valid slug", 400);
    if (desired !== doc.slug && patch.slug !== undefined) {
      await assertSlugAvailable(desired, id);
      // Once a post has ever been public, its old URL must keep resolving.
      const wasEverPublic = Boolean(doc.publishedAt) || doc.status === "PUBLISHED";
      if (wasEverPublic && doc.slug) {
        doc.previousSlugs = [...new Set([...(doc.previousSlugs ?? []), doc.slug])].slice(-20);
      }
      doc.slug = desired;
    }
  }

  if (patch.contentHtml !== undefined) {
    const content = deriveFromRawHtml(patch.contentHtml);
    doc.contentHtml = content.contentHtml;
    doc.contentText = content.contentText;
    doc.readingTimeMinutes = content.readingTimeMinutes;
    doc.tableOfContents = content.tableOfContents;
  }

  if (patch.tags !== undefined) doc.tagIds = await resolveTagIds(patch.tags);
  if (patch.faqs !== undefined) doc.faqs = patch.faqs as any;
  if (patch.schemaEnabled !== undefined) doc.schemaEnabled = patch.schemaEnabled;
  if (patch.relatedBlogIds !== undefined) {
    doc.relatedBlogIds = patch.relatedBlogIds.map((r) => new mongoose.Types.ObjectId(r));
  }

  for (const key of ["featuredImageMediaId", "thumbnailImageMediaId"] as const) {
    if (patch[key] !== undefined) {
      if (patch[key]) {
        await assertImageMedia(patch[key] as string);
        (doc as any)[key] = new mongoose.Types.ObjectId(patch[key] as string);
      } else {
        (doc as any)[key] = undefined;
      }
    }
  }

  if (patch.seo !== undefined) {
    const s = patch.seo;
    if (s.ogImageMediaId) await assertImageMedia(s.ogImageMediaId);
    doc.seo = {
      metaTitle: s.metaTitle?.trim() || undefined,
      metaDescription: s.metaDescription?.trim() || undefined,
      focusKeyword: s.focusKeyword?.trim() || undefined,
      canonicalUrl: s.canonicalUrl?.trim() || undefined,
      ogTitle: s.ogTitle?.trim() || undefined,
      ogDescription: s.ogDescription?.trim() || undefined,
      ogImageMediaId: s.ogImageMediaId ? new mongoose.Types.ObjectId(s.ogImageMediaId) : undefined,
      noIndex: s.noIndex ?? doc.seo?.noIndex ?? false,
      noFollow: s.noFollow ?? doc.seo?.noFollow ?? false,
    } as any;
  }

  if (actorId) doc.updatedBy = new mongoose.Types.ObjectId(actorId);

  await recomputeSeo(doc);
  await doc.save();

  await syncEntityMedia({
    entityType: "BLOG",
    entityId: id,
    nextIds: collectMediaIds(doc),
    prevIds: prevMediaIds,
  });

  return getBlogAdmin(id);
}

// ---------------------------------------------------------------------------
// Admin: status lifecycle
// ---------------------------------------------------------------------------

function assertTransition(from: BlogStatus, to: BlogStatus): void {
  if (from === to) return;
  if (!BLOG_STATUS_TRANSITIONS[from].includes(to)) {
    throw new AppError(`Cannot move a ${from.toLowerCase()} post to ${to.toLowerCase()}`, 400);
  }
}

export async function setBlogStatus(
  id: string,
  nextStatus: BlogStatus,
  opts: { actorId?: string; scheduledFor?: Date; note?: string } = {}
) {
  if (!isValidObjectId(id)) return null;
  const doc = await Blog.findById(id).exec();
  if (!doc) return null;

  assertTransition(doc.status, nextStatus);

  if (nextStatus === "PUBLISHED") {
    if (!doc.contentHtml || doc.contentHtml.trim().length === 0) {
      throw new AppError("Add content before publishing this post", 400);
    }
    if (!doc.featuredImageMediaId) {
      throw new AppError("Add a featured image before publishing this post", 400);
    }
    // Preserve the original publish date on re-publish (SEO "datePublished"
    // stability); updatedAt carries "dateModified".
    if (!doc.publishedAt) doc.publishedAt = new Date();
    doc.scheduledFor = undefined;
    doc.publishedBy = opts.actorId ? new mongoose.Types.ObjectId(opts.actorId) : doc.publishedBy;
  }

  if (nextStatus === "SCHEDULED") {
    if (!opts.scheduledFor || opts.scheduledFor.getTime() <= Date.now()) {
      throw new AppError("A future scheduledFor date is required to schedule a post", 400);
    }
    if (!doc.contentHtml || doc.contentHtml.trim().length === 0) {
      throw new AppError("Add content before scheduling this post", 400);
    }
    if (!doc.featuredImageMediaId) {
      throw new AppError("Add a featured image before scheduling this post", 400);
    }
    doc.scheduledFor = opts.scheduledFor;
  }

  if (nextStatus === "DRAFT") doc.scheduledFor = undefined;

  doc.status = nextStatus;
  doc.statusHistory.push({
    status: nextStatus,
    at: new Date(),
    byUserId: opts.actorId ? new mongoose.Types.ObjectId(opts.actorId) : undefined,
    note: opts.note,
  });
  if (opts.actorId) doc.updatedBy = new mongoose.Types.ObjectId(opts.actorId);

  await doc.save();
  return getBlogAdmin(id);
}

export async function duplicateBlog(id: string, actorId?: string) {
  if (!isValidObjectId(id)) return null;
  const src = await Blog.findById(id).lean();
  if (!src) return null;

  const slug = await uniquify(`${src.slug}-copy`);
  const now = new Date();

  // A Media doc is single-owner (see attachMediaToEntity), so a copy cannot
  // re-attach the source's images. Content, SEO text, category and tags carry
  // over (spec §34); images are left for the admin to re-add on the new draft
  // — which is fine because a DRAFT has no "featured image required" gate. The
  // body keeps its <img src> for visual continuity but the data-media-id
  // ownership markers are stripped so nothing points at source-owned media.
  const seoCopy = src.seo ? { ...src.seo, ogImageMediaId: undefined } : undefined;

  const doc = new Blog({
    title: `${src.title} (Copy)`,
    slug,
    excerpt: src.excerpt,
    contentHtml: (src.contentHtml || "").replace(/\s*data-media-id=["'][a-f0-9]{24}["']/gi, ""),
    contentText: src.contentText,
    readingTimeMinutes: src.readingTimeMinutes,
    tableOfContents: src.tableOfContents,
    author: src.author,
    authorName: src.authorName,
    categoryId: src.categoryId,
    tagIds: src.tagIds,
    status: "DRAFT",
    publishedAt: undefined,
    scheduledFor: undefined,
    statusHistory: [
      { status: "DRAFT", at: now, byUserId: actorId ? new mongoose.Types.ObjectId(actorId) : undefined, note: "Duplicated" },
    ],
    seo: seoCopy,
    schemaEnabled: src.schemaEnabled,
    faqs: src.faqs,
    relatedBlogIds: src.relatedBlogIds,
    createdBy: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
    updatedBy: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
  });

  await recomputeSeo(doc);
  await doc.save();
  return getBlogAdmin(doc._id.toString());
}

export async function deleteBlog(id: string, opts: { hard?: boolean; actorId?: string } = {}) {
  if (!isValidObjectId(id)) return null;
  const doc = await Blog.findById(id).exec();
  if (!doc) return null;

  if (!opts.hard) {
    // Default is a soft delete: archive, keep everything recoverable.
    return setBlogStatus(id, "ARCHIVED", { actorId: opts.actorId, note: "Deleted (archived)" });
  }

  await detachAllEntityMedia("BLOG", id);
  await doc.deleteOne();
  return { hardDeleted: true };
}

export async function bulkBlogAction(
  ids: string[],
  action: "publish" | "unpublish" | "archive" | "delete",
  actorId?: string
) {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      if (action === "publish") await setBlogStatus(id, "PUBLISHED", { actorId });
      else if (action === "unpublish") await setBlogStatus(id, "DRAFT", { actorId });
      else if (action === "archive") await setBlogStatus(id, "ARCHIVED", { actorId });
      else await deleteBlog(id, { hard: true, actorId });
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof AppError ? err.message : "Failed" });
    }
  }
  return {
    succeeded: results.filter((r) => r.ok).map((r) => r.id),
    failed: results.filter((r) => !r.ok),
  };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export async function listBlogsPublic(params: {
  page?: unknown;
  pageSize?: unknown;
  category?: unknown;
  tag?: unknown;
  search?: unknown;
}) {
  const page = Math.max(1, parseInt(String(params.page ?? "1"), 10) || 1);
  const pageSize = Math.min(24, Math.max(1, parseInt(String(params.pageSize ?? "9"), 10) || 9));

  const filter: Record<string, unknown> = publicMatch();

  if (typeof params.category === "string" && params.category.trim()) {
    const cat = await BlogCategory.findOne({ slug: params.category.trim().toLowerCase() }).select("_id").lean();
    filter.categoryId = cat ? cat._id : new mongoose.Types.ObjectId();
  }
  if (typeof params.tag === "string" && params.tag.trim()) {
    const tag = await BlogTag.findOne({ slug: slugify(params.tag) }).select("_id").lean();
    filter.tagIds = tag ? tag._id : new mongoose.Types.ObjectId();
  }

  let query = Blog.find(filter);
  let sort: Record<string, unknown> = { publishedAt: -1 };
  if (typeof params.search === "string" && params.search.trim()) {
    query = Blog.find({ ...filter, $text: { $search: params.search.trim() } }, { score: { $meta: "textScore" } });
    sort = { score: { $meta: "textScore" }, publishedAt: -1 };
  }

  const [docs, total] = await Promise.all([
    query
      .sort(sort as any)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select("-contentHtml -contentText -statusHistory")
      .exec(),
    Blog.countDocuments(
      typeof params.search === "string" && params.search.trim()
        ? { ...filter, $text: { $search: params.search.trim() } }
        : filter
    ),
  ]);

  const refs = await buildLookups(docs as unknown as BlogDocument[]);
  return {
    items: (docs as unknown as BlogDocument[]).map((d) => shapeBlogPublicListItem(d, refs)),
    page,
    pageSize,
    total,
  };
}

export async function getBlogPublic(slug: string): Promise<
  | { post: ReturnType<typeof shapeBlogPublicDetail>; redirectedFrom: string | null }
  | null
> {
  const normalized = slug.toLowerCase();

  let doc = await Blog.findOne({ ...publicMatch(), slug: normalized }).exec();
  let redirectedFrom: string | null = null;

  if (!doc) {
    doc = await Blog.findOne({ ...publicMatch(), previousSlugs: normalized }).exec();
    if (doc) redirectedFrom = normalized;
  }
  if (!doc) return null;

  const refs = await buildLookups([doc]);
  return { post: shapeBlogPublicDetail(doc, refs), redirectedFrom };
}

export async function getRelatedBlogsPublic(slug: string, limit = 3) {
  const current = await Blog.findOne({ ...publicMatch(), slug: slug.toLowerCase() })
    .select("_id categoryId tagIds relatedBlogIds publishedAt")
    .lean();
  if (!current) return [];

  const picked = new Map<string, BlogDocument>();
  const add = (docs: BlogDocument[]) => {
    for (const d of docs) {
      const key = d._id.toString();
      if (key !== current._id.toString() && !picked.has(key)) picked.set(key, d);
      if (picked.size >= limit) break;
    }
  };

  // 1. Manual override, in the admin's chosen order.
  if (current.relatedBlogIds?.length) {
    const manual = await Blog.find({ ...publicMatch(), _id: { $in: current.relatedBlogIds } })
      .select("-contentHtml -contentText -statusHistory")
      .exec();
    const byId = new Map(manual.map((d) => [d._id.toString(), d]));
    add(current.relatedBlogIds.map((rid) => byId.get(rid.toString())).filter(Boolean) as BlogDocument[]);
  }

  // 2. Same category, newest first.
  if (picked.size < limit && current.categoryId) {
    add(
      (await Blog.find({
        ...publicMatch(),
        _id: { $nin: [current._id, ...picked.keys()].map((k) => new mongoose.Types.ObjectId(String(k))) },
        categoryId: current.categoryId,
      })
        .sort({ publishedAt: -1 })
        .limit(limit)
        .select("-contentHtml -contentText -statusHistory")
        .exec()) as unknown as BlogDocument[]
    );
  }

  // 3. Shared tags.
  if (picked.size < limit && current.tagIds?.length) {
    add(
      (await Blog.find({
        ...publicMatch(),
        _id: { $nin: [current._id, ...picked.keys()].map((k) => new mongoose.Types.ObjectId(String(k))) },
        tagIds: { $in: current.tagIds },
      })
        .sort({ publishedAt: -1 })
        .limit(limit)
        .select("-contentHtml -contentText -statusHistory")
        .exec()) as unknown as BlogDocument[]
    );
  }

  // 4. Fall back to most-recent published.
  if (picked.size < limit) {
    add(
      (await Blog.find({
        ...publicMatch(),
        _id: { $nin: [current._id, ...picked.keys()].map((k) => new mongoose.Types.ObjectId(String(k))) },
      })
        .sort({ publishedAt: -1 })
        .limit(limit)
        .select("-contentHtml -contentText -statusHistory")
        .exec()) as unknown as BlogDocument[]
    );
  }

  const chosen = [...picked.values()].slice(0, limit);
  const refs = await buildLookups(chosen);
  return chosen.map((d) => shapeBlogPublicListItem(d, refs));
}

export async function getPublishedBlogSlugsForSitemap(): Promise<{ slug: string; updatedAt: string }[]> {
  const docs = await Blog.find({ ...publicMatch(), "seo.noIndex": false })
    .select("slug updatedAt")
    .lean();
  return docs.map((d) => ({ slug: d.slug, updatedAt: d.updatedAt.toISOString() }));
}

/** Count of live blog posts — the admin dashboard's content signal. */
export async function countPublishedBlogs(): Promise<number> {
  return Blog.countDocuments({ status: "PUBLISHED" });
}
