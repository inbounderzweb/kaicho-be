import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Category, Brand, Media, Product, PageContent } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { createProduct, updateProductById } from "../../product/product.service";
import type { CreateProductInput } from "../../product/product.validation";
import { sanitizePageHtml, sanitizeFaqQuestion } from "../seoContent.sanitize";
import { savePageContentSchema } from "../seoContent.validation";

// RUN with a throwaway MONGO_URI — the project .env points at production.

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const categoryIds: mongoose.Types.ObjectId[] = [];
const brandIds: mongoose.Types.ObjectId[] = [];
const mediaIds: mongoose.Types.ObjectId[] = [];
const productIds: mongoose.Types.ObjectId[] = [];

let adminCookie = "";
let customerCookie = "";

const body = (over: Record<string, unknown> = {}) => ({
  seo: { title: "Static page SEO title", description: "", keywords: ["a", "b"], robotsIndex: true, robotsFollow: true },
  htmlContent: "<h2>Hello</h2><p>World</p>",
  faqEnabled: true,
  faqs: [
    { question: "First?", answer: "<p>One</p>" },
    { question: "Second?", answer: "<p>Two</p>" },
  ],
  ...over,
});

beforeAll(async () => {
  await connectDatabase();
  // This suite wipes the static-page rows, so refuse to run against anything
  // but a local throwaway database (the project .env points at production).
  const host = mongoose.connection.host ?? "";
  if (!/^(localhost|127\.0\.0\.1)$/.test(host) || !/seo|test|tmp|throwaway/i.test(mongoose.connection.name)) {
    throw new Error(`Refusing to run against ${host}/${mongoose.connection.name} — set MONGO_URI to a local throwaway db`);
  }
  const admin = await User.create({ phone: `78${RUN_ID}001`, countryCode: "+91", phoneVerified: true, role: "admin" });
  const customer = await User.create({ phone: `78${RUN_ID}002`, countryCode: "+91", phoneVerified: true, role: "user" });
  userIds.push(admin._id, customer._id);
  adminCookie = `kaicho_session=${signSessionToken(admin)}`;
  customerCookie = `kaicho_session=${signSessionToken(customer)}`;
  // Static pages: start from a clean slate so the suite is repeatable.
  await PageContent.deleteMany({ entityId: { $exists: false } });
});

afterAll(async () => {
  await PageContent.deleteMany({ entityId: { $in: [...categoryIds, ...productIds] } });
  await PageContent.deleteMany({ entityId: { $exists: false } });
  await Product.deleteMany({ _id: { $in: productIds } });
  await Brand.deleteMany({ _id: { $in: brandIds } });
  await Category.deleteMany({ _id: { $in: categoryIds } });
  await Media.deleteMany({ _id: { $in: mediaIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

async function makeCategory(isActive = true) {
  const n = categoryIds.length;
  const c = await Category.create({ name: `SeoCat ${RUN_ID}-${n}`, slug: `seo-cat-${RUN_ID}-${n}`, isActive });
  categoryIds.push(c._id);
  return c;
}

async function makeProduct(activate: boolean) {
  const n = productIds.length;
  const cat = await makeCategory();
  const brand = await Brand.create({ name: `SeoBrand ${RUN_ID}-${n}`, slug: `seo-brand-${RUN_ID}-${n}`, isActive: true });
  brandIds.push(brand._id);
  const media = await Media.create({
    mediaType: "IMAGE",
    storageProvider: "local",
    storageKey: `images/seo-test/${RUN_ID}-${n}`,
    originalName: "p.jpg",
    mimeType: "image/webp",
    extension: "webp",
    size: 100,
    status: "TEMPORARY",
    uploadedBy: userIds[0],
  });
  mediaIds.push(media._id);
  const created = await createProduct({
    name: `Seo Product ${RUN_ID}-${n}`,
    sku: `SEO-${RUN_ID}-${n}`,
    shortDescription: "A short description of the product.",
    description: "A longer description of the product for the product page.",
    categoryId: cat._id.toString(),
    brandId: brand._id.toString(),
    mediaIds: [media._id.toString()],
    pricing: { mrp: 500, sellingPrice: 400, costPrice: 250 },
    inventory: { stockQuantity: 50, lowStockThreshold: 10, trackInventory: true },
    seo: { title: "", description: "", keywords: [] },
  } as CreateProductInput);
  productIds.push(new mongoose.Types.ObjectId(created!.productId));
  const p = activate ? await updateProductById(created!.productId, { status: "ACTIVE" }) : created;
  return p!;
}

describe("HTML sanitization", () => {
  it("strips scripts, handlers, iframes and javascript: URLs but keeps basic markup", () => {
    const dirty =
      '<h1>Title</h1><p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ext.com">ok</a></p>' +
      '<script>alert(1)</script><iframe src="https://evil"></iframe><img src=x onerror=alert(1)><ul><li>a</li></ul>' +
      '<style>body{display:none}</style><form action="/x"><input></form>';
    const clean = sanitizePageHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|iframe|javascript:|<style|<form|<input|<img/i);
    expect(clean).toContain("<h2>Title</h2>");
    expect(clean).toContain("<ul><li>a</li></ul>");
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
  });

  it("FAQ questions are plain text", () => {
    expect(sanitizeFaqQuestion("<b>What</b> is <script>x</script>this?")).toBe("What is this?");
  });
});

describe("validation", () => {
  it("rejects javascript: canonicals, unknown keys and too many FAQs", () => {
    expect(savePageContentSchema.safeParse(body({ seo: { title: "t", canonicalUrl: "javascript:alert(1)" } })).success).toBe(false);
    expect(savePageContentSchema.safeParse({ ...body(), extra: 1 }).success).toBe(false);
    const many = Array.from({ length: 51 }, () => ({ question: "q", answer: "a" }));
    expect(savePageContentSchema.safeParse(body({ faqs: many })).success).toBe(false);
    expect(savePageContentSchema.safeParse(body({ seo: { title: "t", canonicalUrl: "/products" } })).success).toBe(true);
  });
});

describe("admin /api/admin/seo", () => {
  it("requires an admin", async () => {
    expect((await request(app).get("/api/admin/seo/pages")).status).toBe(401);
    expect((await request(app).get("/api/admin/seo/pages").set("Cookie", customerCookie)).status).toBe(403);
  });

  it("404s an unknown page type", async () => {
    const res = await request(app).get("/api/admin/seo/pages/NOPE").set("Cookie", adminCookie);
    expect(res.status).toBe(404);
  });

  it("lists static pages, saves independently per page, preserves FAQ order", async () => {
    const list = await request(app).get("/api/admin/seo/pages").set("Cookie", adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.data.pages.map((p: { pageType: string }) => p.pageType)).toEqual(
      expect.arrayContaining(["HOME", "ABOUT", "CONTACT", "ALL_PRODUCTS"])
    );

    const save = await request(app).put("/api/admin/seo/pages/all_products").set("Cookie", adminCookie).send(body());
    expect(save.status).toBe(200);
    expect(save.body.data.content.faqs.map((f: { question: string }) => f.question)).toEqual(["First?", "Second?"]);

    // reorder + delete via full-array save
    const reorder = await request(app)
      .put("/api/admin/seo/pages/ALL_PRODUCTS")
      .set("Cookie", adminCookie)
      .send(body({ faqs: [{ question: "Second?", answer: "<p>Two</p>" }] }));
    expect(reorder.body.data.content.faqs).toHaveLength(1);

    // another page is untouched
    const about = await request(app).get("/api/admin/seo/pages/ABOUT").set("Cookie", adminCookie);
    expect(about.body.data.content.seo.title).toBe("");
    expect(about.body.data.content.faqs).toEqual([]);
  });

  it("sanitizes HTML on save (server-side, regardless of client)", async () => {
    const res = await request(app)
      .put("/api/admin/seo/pages/HOME")
      .set("Cookie", adminCookie)
      .send(body({ htmlContent: '<p>x</p><script>alert(1)</script><a href="javascript:1">y</a>', faqs: [{ question: "<i>Q</i>", answer: '<p onmouseover="1">A</p>' }] }));
    expect(res.status).toBe(200);
    expect(res.body.data.content.htmlContent).not.toMatch(/script|javascript:/i);
    expect(res.body.data.content.faqs[0].question).toBe("Q");
    expect(res.body.data.content.faqs[0].answer).not.toMatch(/onmouseover/);
  });

  it("drops blank FAQ answers and returns 400 on invalid bodies", async () => {
    const bad = await request(app).put("/api/admin/seo/pages/HOME").set("Cookie", adminCookie).send({ seo: {} , htmlContent: 5 });
    expect(bad.status).toBe(400);
    const blank = await request(app)
      .put("/api/admin/seo/pages/HOME")
      .set("Cookie", adminCookie)
      .send(body({ faqs: [{ question: "Q?", answer: "<p></p>" }] }));
    expect(blank.body.data.content.faqs).toEqual([]);
  });

  it("stores category content in PageContent, isolated per category", async () => {
    const a = await makeCategory();
    const b = await makeCategory();
    const save = await request(app)
      .put(`/api/admin/seo/entities/category/${a._id}`)
      .set("Cookie", adminCookie)
      .send(body({ seo: { title: "Category A title", robotsIndex: false, robotsFollow: true } }));
    expect(save.status).toBe(200);
    expect(save.body.data.content.seo.robotsIndex).toBe(false);
    const other = await request(app).get(`/api/admin/seo/entities/CATEGORY/${b._id}`).set("Cookie", adminCookie);
    expect(other.body.data.content.seo.title).toBe("");
    expect(other.body.data.content.faqs).toEqual([]);
    const missing = await request(app)
      .get(`/api/admin/seo/entities/CATEGORY/${new mongoose.Types.ObjectId()}`)
      .set("Cookie", adminCookie);
    expect(missing.status).toBe(404);
  });

  it("writes product SEO to Product.seo (no duplicate copy) and keeps FAQ per product", async () => {
    const p1 = await makeProduct(true);
    const p2 = await makeProduct(true);
    const save = await request(app)
      .put(`/api/admin/seo/entities/PRODUCT/${p1.productId}`)
      .set("Cookie", adminCookie)
      .send(body({ seo: { title: "Product one SEO title", keywords: ["k"], robotsIndex: true, robotsFollow: false } }));
    expect(save.status).toBe(200);
    const doc = await Product.findById(p1.productId).lean();
    expect(doc?.seo.title).toBe("Product one SEO title");
    expect(doc?.seo.robotsFollow).toBe(false);
    const row = await PageContent.findOne({ pageType: "PRODUCT", entityId: p1.productId }).lean();
    expect(row?.seo?.title ?? "").toBe(""); // not duplicated into PageContent
    const other = await request(app).get(`/api/admin/seo/entities/PRODUCT/${p2.productId}`).set("Cookie", adminCookie);
    expect(other.body.data.content.faqs).toEqual([]);
    expect(other.body.data.content.seo.title).toBe("");
  });
});

describe("public /api/page-content", () => {
  it("returns FAQs only when enabled; empty payload when nothing configured", async () => {
    await request(app).put("/api/admin/seo/pages/CONTACT").set("Cookie", adminCookie).send(body({ faqEnabled: false }));
    const off = await request(app).get("/api/page-content/CONTACT");
    expect(off.status).toBe(200);
    expect(off.body.data.faq).toEqual({ enabled: false, items: [] });
    expect(off.body.data.htmlContent).toContain("Hello");

    await request(app).put("/api/admin/seo/pages/CONTACT").set("Cookie", adminCookie).send(body({ faqEnabled: true }));
    const on = await request(app).get("/api/page-content/contact");
    expect(on.body.data.faq.enabled).toBe(true);
    expect(on.body.data.faq.items).toHaveLength(2);

    const none = await request(app).get("/api/page-content/B2B");
    expect(none.body.data.faq.enabled).toBe(false);
    expect(none.body.data.htmlContent).toBe("");
  });

  it("serves product content by slug and hides DRAFT products / inactive categories", async () => {
    const active = await makeProduct(true);
    const draft = await makeProduct(false);
    await request(app)
      .put(`/api/admin/seo/entities/PRODUCT/${active.productId}`)
      .set("Cookie", adminCookie)
      .send(body());
    const ok = await request(app).get(`/api/page-content/PRODUCT?slug=${active.slug}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.faq.items).toHaveLength(2);
    expect((await request(app).get(`/api/page-content/PRODUCT?slug=${draft.slug}`)).status).toBe(404);
    expect((await request(app).get("/api/page-content/PRODUCT")).status).toBe(400);

    const inactive = await makeCategory(false);
    expect((await request(app).get(`/api/page-content/CATEGORY?slug=${inactive.slug}`)).status).toBe(404);
  });
});
