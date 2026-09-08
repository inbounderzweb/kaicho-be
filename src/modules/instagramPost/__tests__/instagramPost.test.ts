import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, InstagramPost } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureInstagramPostIndexes } from "../instagramPost.indexes";
import { parseInstagramUrl } from "../instagramUrl";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
let userSeq = 0;
let codeSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `78${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

// A fresh, valid, unique post URL per call.
function freshUrl(kind: "p" | "reel" = "p") {
  return `https://www.instagram.com/${kind}/IG${RUN_ID}${codeSeq++}xY/`;
}

let admin: InstanceType<typeof User>;
let normalUser: InstanceType<typeof User>;

async function createPost(cookie: string, body: Record<string, unknown>) {
  return request(app).post("/api/admin/instagram-posts").set("Cookie", cookie).send(body);
}

beforeAll(async () => {
  await connectDatabase();
  await ensureInstagramPostIndexes();
  admin = await makeUser("admin");
  normalUser = await makeUser("user");
});

afterAll(async () => {
  await InstagramPost.deleteMany({ shortCode: new RegExp(`^IG${RUN_ID}`) });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

// ---------------------------------------------------------------------------
// URL parsing / normalisation (pure)
// ---------------------------------------------------------------------------

describe("parseInstagramUrl", () => {
  it("accepts a canonical post URL", () => {
    const r = parseInstagramUrl("https://www.instagram.com/p/ABC123xyz/");
    expect(r).toEqual({
      ok: true,
      value: {
        platform: "INSTAGRAM",
        postType: "POST",
        shortCode: "ABC123xyz",
        canonicalUrl: "https://www.instagram.com/p/ABC123xyz/",
      },
    });
  });

  it("accepts a reel URL (/reel/ and /reels/)", () => {
    expect(parseInstagramUrl("https://www.instagram.com/reel/ABC123/")).toMatchObject({
      ok: true,
      value: { postType: "REEL", canonicalUrl: "https://www.instagram.com/reel/ABC123/" },
    });
    expect(parseInstagramUrl("https://www.instagram.com/reels/ABC123/")).toMatchObject({
      ok: true,
      value: { postType: "REEL", canonicalUrl: "https://www.instagram.com/reel/ABC123/" },
    });
  });

  it("normalises host, query params and trailing slash to one canonical form", () => {
    const forms = [
      "https://instagram.com/p/ABC123",
      "https://www.instagram.com/p/ABC123/?utm_source=test&igshid=x",
      "https://WWW.INSTAGRAM.COM/p/ABC123/",
      "  https://www.instagram.com/p/ABC123/  ",
      "https://www.instagram.com/p/ABC123/#comments",
    ];
    for (const f of forms) {
      const r = parseInstagramUrl(f);
      expect(r.ok && r.value.canonicalUrl, f).toBe("https://www.instagram.com/p/ABC123/");
    }
  });

  it("rejects non-instagram hosts, including look-alikes", () => {
    for (const bad of [
      "https://example.com/fake-instagram-post",
      "https://evil.com/instagram.com/p/ABC123/",
      "https://instagram.com.evil.com/p/ABC123/",
      "https://not-instagram.com/p/ABC123/",
    ]) {
      expect(parseInstagramUrl(bad), bad).toMatchObject({ ok: false, error: "NOT_INSTAGRAM_HOST" });
    }
  });

  it("rejects non-https and dangerous schemes", () => {
    expect(parseInstagramUrl("http://www.instagram.com/p/ABC123/")).toMatchObject({ ok: false, error: "NOT_HTTPS" });
    expect(parseInstagramUrl("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(parseInstagramUrl("data:text/html,<script>alert(1)</script>")).toMatchObject({ ok: false });
    expect(parseInstagramUrl("file:///etc/passwd")).toMatchObject({ ok: false });
  });

  it("rejects unsupported paths (profile / stories / explore)", () => {
    for (const bad of [
      "https://www.instagram.com/kaicho.foods/",
      "https://www.instagram.com/stories/kaicho/123/",
      "https://www.instagram.com/explore/tags/food/",
      "https://www.instagram.com/p/",
    ]) {
      expect(parseInstagramUrl(bad).ok, bad).toBe(false);
    }
  });

  it("rejects malformed, empty and over-long input", () => {
    expect(parseInstagramUrl("not a url")).toMatchObject({ ok: false, error: "MALFORMED" });
    expect(parseInstagramUrl("")).toMatchObject({ ok: false, error: "EMPTY" });
    expect(parseInstagramUrl("   ")).toMatchObject({ ok: false, error: "EMPTY" });
    expect(parseInstagramUrl(null)).toMatchObject({ ok: false, error: "EMPTY" });
    const long = `https://www.instagram.com/p/${"a".repeat(3000)}/`;
    expect(parseInstagramUrl(long)).toMatchObject({ ok: false, error: "TOO_LONG" });
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("instagram posts — authorization", () => {
  it("401 without a session", async () => {
    expect((await request(app).get("/api/admin/instagram-posts")).status).toBe(401);
  });
  it("403 for a non-admin (read and write)", async () => {
    expect((await request(app).get("/api/admin/instagram-posts").set("Cookie", authCookie(normalUser))).status).toBe(403);
    expect((await createPost(authCookie(normalUser), { url: freshUrl() })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Create + duplicates + concurrency
// ---------------------------------------------------------------------------

describe("instagram posts — create", () => {
  it("stores the canonical URL and the parsed identity", async () => {
    const code = `IG${RUN_ID}${codeSeq++}xY`;
    const res = await createPost(authCookie(admin), {
      url: `https://instagram.com/p/${code}?utm_source=x`,
      displayOrder: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.post).toMatchObject({
      url: `https://www.instagram.com/p/${code}/`,
      platform: "INSTAGRAM",
      postType: "POST",
      shortCode: code,
      displayOrder: 2,
      status: "ACTIVE",
    });
  });

  it("auto-assigns the next display order when omitted", async () => {
    const a = await createPost(authCookie(admin), { url: freshUrl() });
    const b = await createPost(authCookie(admin), { url: freshUrl() });
    expect(b.body.data.post.displayOrder).toBe(a.body.data.post.displayOrder + 1);
  });

  it("rejects an invalid URL with a clean 400 message (no DB internals)", async () => {
    const res = await createPost(authCookie(admin), { url: "https://example.com/p/ABC123/" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/instagram\.com/i);
    // No Mongo / driver leakage in the customer-visible message.
    expect(res.body.message).not.toMatch(/E11000|mongo|ValidationError|cast/i);
  });

  it("409s on a duplicate — even when the URL is spelled differently", async () => {
    const code = `IG${RUN_ID}${codeSeq++}xY`;
    const first = await createPost(authCookie(admin), { url: `https://www.instagram.com/p/${code}/` });
    expect(first.status).toBe(201);
    const dup = await createPost(authCookie(admin), {
      url: `https://instagram.com/p/${code}/?utm_source=newsletter`,
    });
    expect(dup.status).toBe(409);
  });

  it("survives concurrent duplicate creation — exactly one wins", async () => {
    const code = `IG${RUN_ID}${codeSeq++}xY`;
    const url = `https://www.instagram.com/p/${code}/`;
    const results = await Promise.all(
      Array.from({ length: 6 }).map(() => createPost(authCookie(admin), { url }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await InstagramPost.countDocuments({ shortCode: code })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mass assignment / security
// ---------------------------------------------------------------------------

describe("instagram posts — security", () => {
  it("strips unknown/privileged fields on create (mass assignment)", async () => {
    const otherId = new mongoose.Types.ObjectId();
    const code = `IG${RUN_ID}${codeSeq++}xY`;
    const res = await createPost(authCookie(admin), {
      url: `https://www.instagram.com/p/${code}/`,
      createdBy: otherId.toString(),
      _id: new mongoose.Types.ObjectId().toString(),
      shortCode: "HACKED",
      platform: "EVIL",
    });
    expect(res.status).toBe(201);
    const doc = await InstagramPost.findById(res.body.data.post.id).lean();
    expect(doc!.shortCode).toBe(code);
    expect(doc!.platform).toBe("INSTAGRAM");
    expect(doc!.createdBy?.toString()).toBe(admin._id.toString());
  });

  it("rejects setting ARCHIVED directly on create", async () => {
    const res = await createPost(authCookie(admin), { url: freshUrl(), status: "ARCHIVED" });
    expect(res.status).toBe(400);
  });

  it("rejects an XSS / script payload as a URL", async () => {
    for (const bad of [
      '<script>alert(1)</script>',
      'javascript:alert(document.cookie)',
      'https://www.instagram.com/p/"><img src=x onerror=alert(1)>/',
    ]) {
      expect((await createPost(authCookie(admin), { url: bad })).status, bad).toBe(400);
    }
  });

  it("404s (not 500) for a malformed or unknown id — no IDOR surface", async () => {
    expect((await request(app).get("/api/admin/instagram-posts/not-an-id").set("Cookie", authCookie(admin))).status).toBe(404);
    expect((await request(app).get(`/api/admin/instagram-posts/${new mongoose.Types.ObjectId()}`).set("Cookie", authCookie(admin))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe("instagram posts — update / status / archive", () => {
  async function seed() {
    const res = await createPost(authCookie(admin), { url: freshUrl(), displayOrder: 10 });
    return res.body.data.post.id as string;
  }

  it("updates URL (re-normalised), display order and status through one endpoint", async () => {
    const id = await seed();
    const newCode = `IG${RUN_ID}${codeSeq++}xY`;
    const res = await request(app)
      .patch(`/api/admin/instagram-posts/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ url: `https://instagram.com/reel/${newCode}?igshid=1`, displayOrder: 3, status: "INACTIVE" });
    expect(res.status).toBe(200);
    expect(res.body.data.post).toMatchObject({
      url: `https://www.instagram.com/reel/${newCode}/`,
      postType: "REEL",
      shortCode: newCode,
      displayOrder: 3,
      status: "INACTIVE",
    });
  });

  it("PATCH /:id/status toggles state", async () => {
    const id = await seed();
    const res = await request(app)
      .patch(`/api/admin/instagram-posts/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "INACTIVE" });
    expect(res.body.data.post.status).toBe("INACTIVE");
  });

  it("rejects an empty PATCH body", async () => {
    const id = await seed();
    const res = await request(app).patch(`/api/admin/instagram-posts/${id}`).set("Cookie", authCookie(admin)).send({});
    expect(res.status).toBe(400);
  });

  it("DELETE soft-archives; archived posts drop out of the default list", async () => {
    const id = await seed();
    const del = await request(app).delete(`/api/admin/instagram-posts/${id}`).set("Cookie", authCookie(admin));
    expect(del.status).toBe(200);
    expect((await InstagramPost.findById(id).lean())!.status).toBe("ARCHIVED");

    const defaultList = await request(app)
      .get("/api/admin/instagram-posts?pageSize=100")
      .set("Cookie", authCookie(admin));
    expect(defaultList.body.data.items.some((p: { id: string }) => p.id === id)).toBe(false);

    const archivedList = await request(app)
      .get("/api/admin/instagram-posts?status=ARCHIVED&pageSize=100")
      .set("Cookie", authCookie(admin));
    expect(archivedList.body.data.items.some((p: { id: string }) => p.id === id)).toBe(true);
  });

  it("can restore an archived post via the status endpoint", async () => {
    const id = await seed();
    await request(app).delete(`/api/admin/instagram-posts/${id}`).set("Cookie", authCookie(admin));
    const res = await request(app)
      .patch(`/api/admin/instagram-posts/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "ACTIVE" });
    expect(res.body.data.post.status).toBe("ACTIVE");
  });
});

describe("instagram posts — list", () => {
  it("orders by displayOrder and supports search + pagination", async () => {
    const marker = `IG${RUN_ID}${codeSeq++}xY`;
    await createPost(authCookie(admin), { url: `https://www.instagram.com/p/${marker}/`, displayOrder: 999 });

    const search = await request(app)
      .get(`/api/admin/instagram-posts?search=${marker}`)
      .set("Cookie", authCookie(admin));
    expect(search.status).toBe(200);
    expect(search.body.data.items).toHaveLength(1);
    expect(search.body.data.items[0].shortCode).toBe(marker);

    const page = await request(app)
      .get("/api/admin/instagram-posts?page=1&pageSize=2")
      .set("Cookie", authCookie(admin));
    expect(page.body.data.items.length).toBeLessThanOrEqual(2);
    expect(page.body.data).toMatchObject({ page: 1, pageSize: 2 });
    const orders = page.body.data.items.map((p: { displayOrder: number }) => p.displayOrder);
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b));
  });
});
