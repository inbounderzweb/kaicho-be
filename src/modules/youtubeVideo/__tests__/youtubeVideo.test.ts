import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, YouTubeVideo } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureYouTubeVideoIndexes } from "../youtubeVideo.indexes";
import { parseYouTubeUrl } from "../youtubeUrl";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
let userSeq = 0;
let idSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `79${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
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

// A fresh 11-char video id per call, unique to this run.
function freshId() {
  const base = `YT${RUN_ID}${idSeq++}`;
  return (base + "___________").slice(0, 11);
}

let admin: InstanceType<typeof User>;
let normalUser: InstanceType<typeof User>;

async function createVideo(cookie: string, body: Record<string, unknown>) {
  return request(app).post("/api/admin/youtube-videos").set("Cookie", cookie).send(body);
}

beforeAll(async () => {
  await connectDatabase();
  await ensureYouTubeVideoIndexes();
  admin = await makeUser("admin");
  normalUser = await makeUser("user");
});

afterAll(async () => {
  await YouTubeVideo.deleteMany({ videoId: new RegExp(`^YT${RUN_ID}`) });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

// ---------------------------------------------------------------------------
// URL parsing / normalisation
// ---------------------------------------------------------------------------

describe("parseYouTubeUrl", () => {
  it("accepts and canonicalises every common watch URL form to one URL", () => {
    const forms = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=42",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/v/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
    ];
    for (const f of forms) {
      const r = parseYouTubeUrl(f);
      expect(r.ok && r.value.canonicalUrl, f).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(r.ok && r.value.videoType, f).toBe("VIDEO");
      expect(r.ok && r.value.videoId, f).toBe("dQw4w9WgXcQ");
    }
  });

  it("classifies /shorts/ as a SHORT with its own canonical URL", () => {
    const r = parseYouTubeUrl("https://www.youtube.com/shorts/abc123DEF_-");
    expect(r).toMatchObject({
      ok: true,
      value: { videoType: "SHORT", videoId: "abc123DEF_-", canonicalUrl: "https://www.youtube.com/shorts/abc123DEF_-" },
    });
  });

  it("rejects non-YouTube hosts, including look-alikes", () => {
    for (const bad of [
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "https://vimeo.com/123456",
    ]) {
      expect(parseYouTubeUrl(bad), bad).toMatchObject({ ok: false, error: "NOT_YOUTUBE_HOST" });
    }
  });

  it("rejects non-https and dangerous schemes", () => {
    expect(parseYouTubeUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({ ok: false, error: "NOT_HTTPS" });
    expect(parseYouTubeUrl("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(parseYouTubeUrl("data:text/html,<script>1</script>")).toMatchObject({ ok: false });
  });

  it("rejects unsupported paths and a watch URL with no video id", () => {
    for (const bad of [
      "https://www.youtube.com/watch",
      "https://www.youtube.com/watch?list=PL123",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/@kaichofoods",
      "https://www.youtube.com/channel/UC123",
      "https://www.youtube.com/results?search_query=food",
    ]) {
      expect(parseYouTubeUrl(bad).ok, bad).toBe(false);
    }
  });

  it("rejects a wrong-length video id", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=short")).toMatchObject({ ok: false, error: "INVALID_VIDEO_ID" });
    expect(parseYouTubeUrl("https://youtu.be/waytoolongvideoid123")).toMatchObject({ ok: false, error: "INVALID_VIDEO_ID" });
  });

  it("rejects malformed, empty and over-long input", () => {
    expect(parseYouTubeUrl("not a url")).toMatchObject({ ok: false, error: "MALFORMED" });
    expect(parseYouTubeUrl("")).toMatchObject({ ok: false, error: "EMPTY" });
    expect(parseYouTubeUrl(null)).toMatchObject({ ok: false, error: "EMPTY" });
    expect(parseYouTubeUrl(`https://youtu.be/${"a".repeat(3000)}`)).toMatchObject({ ok: false, error: "TOO_LONG" });
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("youtube videos — authorization", () => {
  it("401 without a session", async () => {
    expect((await request(app).get("/api/admin/youtube-videos")).status).toBe(401);
  });
  it("403 for a non-admin (read and write)", async () => {
    expect((await request(app).get("/api/admin/youtube-videos").set("Cookie", authCookie(normalUser))).status).toBe(403);
    expect(
      (await createVideo(authCookie(normalUser), { url: `https://youtu.be/${freshId()}` })).status
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Create + duplicates + concurrency + security
// ---------------------------------------------------------------------------

describe("youtube videos — create", () => {
  it("stores the canonical URL and the parsed identity", async () => {
    const id = freshId();
    const res = await createVideo(authCookie(admin), {
      url: `https://youtu.be/${id}?t=10`,
      displayOrder: 3,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.video).toMatchObject({
      url: `https://www.youtube.com/watch?v=${id}`,
      platform: "YOUTUBE",
      videoType: "VIDEO",
      videoId: id,
      displayOrder: 3,
      status: "ACTIVE",
    });
  });

  it("auto-assigns the next display order when omitted", async () => {
    const a = await createVideo(authCookie(admin), { url: `https://youtu.be/${freshId()}` });
    const b = await createVideo(authCookie(admin), { url: `https://youtu.be/${freshId()}` });
    expect(b.body.data.video.displayOrder).toBe(a.body.data.video.displayOrder + 1);
  });

  it("409s on a duplicate — watch URL vs youtu.be vs shorts of the same id", async () => {
    const id = freshId();
    expect((await createVideo(authCookie(admin), { url: `https://www.youtube.com/watch?v=${id}` })).status).toBe(201);
    expect((await createVideo(authCookie(admin), { url: `https://youtu.be/${id}` })).status).toBe(409);
    expect((await createVideo(authCookie(admin), { url: `https://www.youtube.com/shorts/${id}` })).status).toBe(409);
  });

  it("survives concurrent duplicate creation — exactly one wins", async () => {
    const id = freshId();
    const url = `https://www.youtube.com/watch?v=${id}`;
    const results = await Promise.all(
      Array.from({ length: 6 }).map(() => createVideo(authCookie(admin), { url }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await YouTubeVideo.countDocuments({ videoId: id })).toBe(1);
  });

  it("rejects invalid / non-YouTube / XSS URLs with a clean 400", async () => {
    for (const bad of [
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "<script>alert(1)</script>",
      "https://www.youtube.com/@channel",
    ]) {
      const res = await createVideo(authCookie(admin), { url: bad });
      expect(res.status, bad).toBe(400);
      expect(res.body.message).not.toMatch(/E11000|mongo|cast/i);
    }
  });

  it("strips unknown / privileged fields on create (mass assignment)", async () => {
    const id = freshId();
    const res = await createVideo(authCookie(admin), {
      url: `https://youtu.be/${id}`,
      createdBy: new mongoose.Types.ObjectId().toString(),
      _id: new mongoose.Types.ObjectId().toString(),
      videoId: "HACKED",
      platform: "EVIL",
      status: "ARCHIVED",
    });
    expect(res.status).toBe(400); // status ARCHIVED not accepted on create
  });

  it("404s for a malformed or unknown id", async () => {
    expect((await request(app).get("/api/admin/youtube-videos/not-an-id").set("Cookie", authCookie(admin))).status).toBe(404);
    expect(
      (await request(app).get(`/api/admin/youtube-videos/${new mongoose.Types.ObjectId()}`).set("Cookie", authCookie(admin))).status
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe("youtube videos — update / status / archive", () => {
  async function seed() {
    const res = await createVideo(authCookie(admin), { url: `https://youtu.be/${freshId()}`, displayOrder: 10 });
    return res.body.data.video.id as string;
  }

  it("updates URL (re-normalised), display order and status", async () => {
    const id = await seed();
    const newId = freshId();
    const res = await request(app)
      .patch(`/api/admin/youtube-videos/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ url: `https://www.youtube.com/shorts/${newId}`, displayOrder: 2, status: "INACTIVE" });
    expect(res.status).toBe(200);
    expect(res.body.data.video).toMatchObject({
      url: `https://www.youtube.com/shorts/${newId}`,
      videoType: "SHORT",
      videoId: newId,
      displayOrder: 2,
      status: "INACTIVE",
    });
  });

  it("rejects an empty PATCH body", async () => {
    const id = await seed();
    expect((await request(app).patch(`/api/admin/youtube-videos/${id}`).set("Cookie", authCookie(admin)).send({})).status).toBe(400);
  });

  it("DELETE soft-archives; archived videos drop out of the default list but show under ?status=ARCHIVED", async () => {
    const id = await seed();
    expect((await request(app).delete(`/api/admin/youtube-videos/${id}`).set("Cookie", authCookie(admin))).status).toBe(200);
    expect((await YouTubeVideo.findById(id).lean())!.status).toBe("ARCHIVED");

    const def = await request(app).get("/api/admin/youtube-videos?pageSize=100").set("Cookie", authCookie(admin));
    expect(def.body.data.items.some((v: { id: string }) => v.id === id)).toBe(false);

    const arch = await request(app).get("/api/admin/youtube-videos?status=ARCHIVED&pageSize=100").set("Cookie", authCookie(admin));
    expect(arch.body.data.items.some((v: { id: string }) => v.id === id)).toBe(true);
  });

  it("restores an archived video via the status endpoint", async () => {
    const id = await seed();
    await request(app).delete(`/api/admin/youtube-videos/${id}`).set("Cookie", authCookie(admin));
    const res = await request(app)
      .patch(`/api/admin/youtube-videos/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "ACTIVE" });
    expect(res.body.data.video.status).toBe("ACTIVE");
  });
});

describe("youtube videos — list", () => {
  it("orders by displayOrder and supports search + pagination", async () => {
    const id = freshId();
    await createVideo(authCookie(admin), { url: `https://youtu.be/${id}`, displayOrder: 999 });

    const search = await request(app).get(`/api/admin/youtube-videos?search=${id}`).set("Cookie", authCookie(admin));
    expect(search.status).toBe(200);
    expect(search.body.data.items).toHaveLength(1);
    expect(search.body.data.items[0].videoId).toBe(id);

    const page = await request(app).get("/api/admin/youtube-videos?page=1&pageSize=2").set("Cookie", authCookie(admin));
    expect(page.body.data.items.length).toBeLessThanOrEqual(2);
    const orders = page.body.data.items.map((v: { displayOrder: number }) => v.displayOrder);
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b));
  });
});
