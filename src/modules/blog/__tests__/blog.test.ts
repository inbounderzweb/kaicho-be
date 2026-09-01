import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, Blog, BlogCategory, BlogTag } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import {
  createBlog,
  updateBlog,
  setBlogStatus,
  duplicateBlog,
  deleteBlog,
  bulkBlogAction,
  getBlogPublic,
  listBlogsPublic,
} from "../blog.service";
import { sanitizeBlogHtml } from "../blog.sanitize";
import { deriveContentMeta } from "../blog.content";
import { publishDueScheduledBlogs } from "../blogScheduler";

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const mediaIds: mongoose.Types.ObjectId[] = [];
const blogIds: mongoose.Types.ObjectId[] = [];
const categoryIds: mongoose.Types.ObjectId[] = [];

let adminUser: InstanceType<typeof User>;
let category: InstanceType<typeof BlogCategory>;
let image: InstanceType<typeof Media>;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `9${RUN_ID}${String(userIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  userIds.push(user._id);
  return user;
}

async function makeImage(altText?: string) {
  const media = await Media.create({
    mediaType: "IMAGE",
    storageProvider: "local",
    storageKey: `images/test/${RUN_ID}-${mediaIds.length}`,
    variants: {
      thumbnail: { key: `images/test/${RUN_ID}-${mediaIds.length}/t.webp`, width: 300, height: 200, size: 10 },
      medium: { key: `images/test/${RUN_ID}-${mediaIds.length}/m.webp`, width: 800, height: 533, size: 30 },
      optimized: { key: `images/test/${RUN_ID}-${mediaIds.length}/o.webp`, width: 1600, height: 1066, size: 80 },
    },
    originalName: "hero.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: 80,
    altText,
    status: "TEMPORARY",
    uploadedBy: adminUser._id,
  });
  mediaIds.push(media._id);
  return media;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user as any)}`;
}

// A Media doc is single-owner (see attachMediaToEntity), so every blog needs
// its own featured image unless the test explicitly overrides it.
async function baseInput(overrides: Record<string, unknown> = {}) {
  const fresh = await makeImage("A bowl of cooked millet");
  return {
    title: `Best Organic Millet Products ${RUN_ID}`,
    excerpt: "A short teaser about millets.",
    contentHtml: "<h2>Benefits</h2><p>Millets are great. " + "word ".repeat(60) + "</p>",
    author: adminUser._id.toString(),
    categoryId: category._id.toString(),
    featuredImageMediaId: fresh._id.toString(),
    ...overrides,
  };
}

beforeAll(async () => {
  await connectDatabase();
  adminUser = await makeUser("admin");
  category = await BlogCategory.create({ name: `Nutrition ${RUN_ID}`, slug: `nutrition-${RUN_ID}` });
  categoryIds.push(category._id);
  image = await makeImage("A bowl of cooked millet");
});

afterAll(async () => {
  await Blog.deleteMany({ _id: { $in: blogIds } });
  await BlogCategory.deleteMany({ _id: { $in: categoryIds } });
  await BlogTag.deleteMany({ slug: new RegExp(RUN_ID) });
  await Media.deleteMany({ _id: { $in: mediaIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

// ---------------------------------------------------------------------------

describe("blog.sanitize", () => {
  it("strips <script>, event handlers and javascript: urls", () => {
    const dirty =
      '<p onclick="steal()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="p()">';
    const clean = sanitizeBlogHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/onerror/i);
    expect(clean).not.toMatch(/javascript:/i);
  });

  it("downgrades a body <h1> to <h2>", () => {
    expect(sanitizeBlogHtml("<h1>Title in body</h1>")).toBe("<h2>Title in body</h2>");
  });

  it("marks external links nofollow but leaves internal links alone", () => {
    const clean = sanitizeBlogHtml('<a href="https://evil.example">x</a><a href="/products">y</a>');
    expect(clean).toMatch(/href="https:\/\/evil\.example"[^>]*rel="noopener noreferrer nofollow"/);
    expect(clean).toMatch(/href="\/products"[^>]*rel="noopener"/);
    expect(clean).not.toMatch(/href="\/products"[^>]*nofollow/);
  });
});

describe("blog.content", () => {
  it("injects stable, de-duplicated heading ids and builds a TOC", () => {
    const { contentHtml, tableOfContents, readingTimeMinutes } = deriveContentMeta(
      "<h2>Benefits</h2><p>a b c</p><h3>Benefits</h3><h2>How to Use</h2>"
    );
    expect(contentHtml).toContain('<h2 id="benefits">');
    expect(contentHtml).toContain('<h3 id="benefits-2">');
    expect(contentHtml).toContain('<h2 id="how-to-use">');
    expect(tableOfContents.map((t) => t.id)).toEqual(["benefits", "benefits-2", "how-to-use"]);
    expect(readingTimeMinutes).toBeGreaterThanOrEqual(1);
  });
});

describe("blog.service — slugs", () => {
  it("auto-generates a slug from the title", async () => {
    const blog = await createBlog(await baseInput({ title: `Healthy Lifestyle Guide ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(blog!.blogId));
    expect(blog!.slug).toBe(`healthy-lifestyle-guide-${RUN_ID}`);
  });

  it("normalizes a manually supplied slug rather than trusting it raw", async () => {
    const blog = await createBlog(
      await baseInput({ title: `Manual ${RUN_ID}`, slug: `Custom Slug!! ${RUN_ID}` }),
      adminUser._id.toString()
    );
    blogIds.push(new mongoose.Types.ObjectId(blog!.blogId));
    expect(blog!.slug).toBe(`custom-slug-${RUN_ID}`);
  });

  it("keeps the old slug in previousSlugs when a published post is re-slugged, and 308s from it", async () => {
    const blog = await createBlog(await baseInput({ title: `Rename Me ${RUN_ID}` }), adminUser._id.toString());
    const id = blog!.blogId;
    blogIds.push(new mongoose.Types.ObjectId(id));
    await setBlogStatus(id, "PUBLISHED", { actorId: adminUser._id.toString() });

    const oldSlug = blog!.slug;
    const updated = await updateBlog(id, { slug: `renamed-${RUN_ID}` }, adminUser._id.toString());
    expect(updated!.slug).toBe(`renamed-${RUN_ID}`);
    expect(updated!.previousSlugs).toContain(oldSlug);

    const viaOld = await getBlogPublic(oldSlug);
    expect(viaOld?.redirectedFrom).toBe(oldSlug);
    expect(viaOld?.post.slug).toBe(`renamed-${RUN_ID}`);
  });

  it("rejects a slug already used (or previously used) by another post", async () => {
    const a = await createBlog(await baseInput({ title: `Clash A ${RUN_ID}`, slug: `clash-a-${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(a!.blogId));
    const b = await createBlog(await baseInput({ title: `Clash B ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(b!.blogId));
    await expect(updateBlog(b!.blogId, { slug: `clash-a-${RUN_ID}` }, adminUser._id.toString())).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("blog.service — status lifecycle", () => {
  it("rejects an illegal transition (ARCHIVED -> PUBLISHED)", async () => {
    const blog = await createBlog(await baseInput({ title: `Lifecycle ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(blog!.blogId));
    await setBlogStatus(blog!.blogId, "ARCHIVED", { actorId: adminUser._id.toString() });
    await expect(setBlogStatus(blog!.blogId, "PUBLISHED", { actorId: adminUser._id.toString() })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("refuses to publish without content", async () => {
    const blog = await createBlog(
      await baseInput({ title: `No Content ${RUN_ID}`, contentHtml: "" }),
      adminUser._id.toString()
    );
    blogIds.push(new mongoose.Types.ObjectId(blog!.blogId));
    await expect(setBlogStatus(blog!.blogId, "PUBLISHED", { actorId: adminUser._id.toString() })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("refuses to publish without a featured image", async () => {
    const blog = await createBlog(
      await baseInput({ title: `No Image ${RUN_ID}`, featuredImageMediaId: "" }),
      adminUser._id.toString()
    );
    blogIds.push(new mongoose.Types.ObjectId(blog!.blogId));
    await expect(setBlogStatus(blog!.blogId, "PUBLISHED", { actorId: adminUser._id.toString() })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("blog.service — public exposure", () => {
  it("never exposes DRAFT or ARCHIVED posts", async () => {
    const draft = await createBlog(await baseInput({ title: `Hidden Draft ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(draft!.blogId));
    expect(await getBlogPublic(draft!.slug)).toBeNull();

    const pub = await createBlog(await baseInput({ title: `Then Archived ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(pub!.blogId));
    await setBlogStatus(pub!.blogId, "PUBLISHED", { actorId: adminUser._id.toString() });
    await setBlogStatus(pub!.blogId, "ARCHIVED", { actorId: adminUser._id.toString() });
    expect(await getBlogPublic(pub!.slug)).toBeNull();
  });

  it("keeps a SCHEDULED post private until the cron publishes it", async () => {
    const blog = await createBlog(await baseInput({ title: `Scheduled ${RUN_ID}` }), adminUser._id.toString());
    const id = blog!.blogId;
    blogIds.push(new mongoose.Types.ObjectId(id));

    await setBlogStatus(id, "SCHEDULED", {
      actorId: adminUser._id.toString(),
      scheduledFor: new Date(Date.now() + 60_000),
    });
    expect(await getBlogPublic(blog!.slug)).toBeNull();

    // Move the schedule into the past and run the sweep.
    await Blog.findByIdAndUpdate(id, { scheduledFor: new Date(Date.now() - 1000) });
    const result = await publishDueScheduledBlogs();
    expect(result.published).toBeGreaterThanOrEqual(1);

    const live = await getBlogPublic(blog!.slug);
    expect(live?.post.slug).toBe(blog!.slug);
  });
});

describe("blog.service — duplicate & delete", () => {
  it("duplicates as a fresh DRAFT with a new slug", async () => {
    const src = await createBlog(await baseInput({ title: `Dup Source ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(src!.blogId));
    await setBlogStatus(src!.blogId, "PUBLISHED", { actorId: adminUser._id.toString() });

    const copy = await duplicateBlog(src!.blogId, adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(copy!.blogId));
    expect(copy!.status).toBe("DRAFT");
    expect(copy!.slug).toBe(`${src!.slug}-copy`);
    expect(copy!.publishedAt).toBeNull();
    // Single-owner media can't be re-attached to a copy — admin re-adds it.
    expect(copy!.featuredImage).toBeNull();
    expect(copy!.excerpt).toBe(src!.excerpt);
  });

  it("soft-deletes to ARCHIVED by default, hard-deletes only when asked", async () => {
    const blog = await createBlog(await baseInput({ title: `Delete Me ${RUN_ID}` }), adminUser._id.toString());
    const id = blog!.blogId;
    blogIds.push(new mongoose.Types.ObjectId(id));

    const soft = await deleteBlog(id, { actorId: adminUser._id.toString() });
    expect((soft as any).status).toBe("ARCHIVED");
    expect(await Blog.findById(id)).not.toBeNull();

    const hard = await deleteBlog(id, { hard: true, actorId: adminUser._id.toString() });
    expect((hard as any).hardDeleted).toBe(true);
    expect(await Blog.findById(id)).toBeNull();
  });

  it("bulk-archives a set of posts", async () => {
    const a = await createBlog(await baseInput({ title: `Bulk A ${RUN_ID}` }), adminUser._id.toString());
    const b = await createBlog(await baseInput({ title: `Bulk B ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(a!.blogId), new mongoose.Types.ObjectId(b!.blogId));
    const res = await bulkBlogAction([a!.blogId, b!.blogId], "archive", adminUser._id.toString());
    expect(res.succeeded).toHaveLength(2);
    expect((await Blog.findById(a!.blogId))!.status).toBe("ARCHIVED");
  });
});

describe("blog routes — auth", () => {
  it("rejects the admin list without a session", async () => {
    const res = await request(app).get("/api/admin/blogs");
    expect(res.status).toBe(401);
  });

  it("rejects the admin list for a non-admin", async () => {
    const normal = await makeUser("user");
    const res = await request(app).get("/api/admin/blogs").set("Cookie", authCookie(normal));
    expect(res.status).toBe(403);
  });

  it("serves the public list unauthenticated and only published posts", async () => {
    const pub = await createBlog(await baseInput({ title: `Public List ${RUN_ID}` }), adminUser._id.toString());
    blogIds.push(new mongoose.Types.ObjectId(pub!.blogId));
    await setBlogStatus(pub!.blogId, "PUBLISHED", { actorId: adminUser._id.toString() });

    const res = await request(app).get(`/api/blogs?search=Public List ${RUN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((i: any) => i.slug === pub!.slug)).toBe(true);
  });
});

describe("blog list (public) pagination", () => {
  it("caps pageSize and reports total", async () => {
    const res = await listBlogsPublic({ pageSize: "999" });
    expect(res.pageSize).toBeLessThanOrEqual(24);
    expect(typeof res.total).toBe("number");
  });
});
