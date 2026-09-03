import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Media, MediaUsage } from "../../../database/models";
import { attachMediaToEntity, detachMedia } from "../media.service";
import { signSessionToken } from "../../auth/auth.service";
import { getMediaRoot } from "../media.storage";
import { cleanupExpiredTemporaryMedia } from "../mediaCleanup";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdMediaIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `9${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

// Each synthetic image gets a random background so its processed bytes — and
// therefore its content hash — are unique per call. The upload pipeline now
// dedupes byte-identical images (spec §17), so fixtures that reuse the exact
// same solid color would otherwise all resolve to the first one uploaded.
const rnd = () => Math.floor(Math.random() * 256);

async function jpegBuffer(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rnd(), g: rnd(), b: rnd() } },
  })
    .jpeg()
    .toBuffer();
}

async function pngWithAlphaBuffer(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: rnd(), g: rnd(), b: rnd(), alpha: 0 } },
  })
    .png()
    .toBuffer();
}

async function webpBuffer(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rnd(), g: rnd(), b: rnd() } },
  })
    .webp()
    .toBuffer();
}

async function avifBuffer(width = 200, height = 150): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rnd(), g: rnd(), b: rnd() } },
  })
    .avif({ quality: 50 })
    .toBuffer();
}

// Byte-accurate minimal single-page PDF, built by tracking each object's
// offset as it's appended — real enough for pdf-parse to extract a page
// count of 1, not just pass the header/EOF sniff.
function minimalPdfBuffer(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  // Best-effort physical cleanup for anything this run wrote to disk.
  for (const id of createdMediaIds) {
    const doc = await Media.findById(id).lean();
    if (!doc) continue;
    const keys = doc.variants
      ? [doc.variants.thumbnail.key, doc.variants.medium.key, doc.variants.optimized.key]
      : [doc.storageKey];
    for (const key of keys) {
      const p = path.join(getMediaRoot(), key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  await MediaUsage.deleteMany({ mediaId: { $in: createdMediaIds } });
  await Media.deleteMany({ _id: { $in: createdMediaIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Media upload (integration)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/admin/media");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin with 403", async () => {
    const user = await makeUser("user");
    const res = await request(app).get("/api/admin/media").set("Cookie", authCookie(user));
    expect(res.status).toBe(403);
  });

  it("uploads a JPEG and generates thumbnail/medium/optimized variants", async () => {
    const admin = await makeUser("admin");
    const buf = await jpegBuffer(2000, 1000);

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, "photo.jpg");

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
    const item = res.body.data[0];
    createdMediaIds.push(new mongoose.Types.ObjectId(item.mediaId));

    expect(item.mediaType).toBe("IMAGE");
    expect(item.status).toBe("TEMPORARY");
    expect(item.thumbnailUrl).toBeTruthy();
    expect(item.mediumUrl).toBeTruthy();
    expect(item.url).toBeTruthy();
    // 2000x1000 has no alpha -> stored as webp per the pipeline's rule
    expect(item.mimeType).toBe("image/webp");

    const doc = await Media.findById(item.mediaId).lean();
    expect(doc?.variants?.thumbnail.width).toBeLessThanOrEqual(300);
    expect(doc?.variants?.optimized.width).toBeLessThanOrEqual(1600);
    // aspect ratio preserved (2:1)
    const optimized = doc!.variants!.optimized;
    expect(Math.abs(optimized.width / optimized.height - 2)).toBeLessThan(0.05);

    for (const variant of Object.values(doc!.variants!)) {
      expect(fs.existsSync(path.join(getMediaRoot(), variant.key))).toBe(true);
    }
  });

  it("preserves transparency by storing alpha PNGs as PNG, not flattened to JPEG", async () => {
    const admin = await makeUser("admin");
    const buf = await pngWithAlphaBuffer(500, 500);

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, "logo.png");

    expect(res.status).toBe(201);
    const item = res.body.data[0];
    createdMediaIds.push(new mongoose.Types.ObjectId(item.mediaId));
    expect(item.mimeType).toBe("image/png");
  });

  it("uploads WebP and AVIF successfully", async () => {
    const admin = await makeUser("admin");
    const webp = await webpBuffer();
    const avif = await avifBuffer();

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", webp, "a.webp")
      .attach("files", avif, "b.avif");

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    for (const item of res.body.data) createdMediaIds.push(new mongoose.Types.ObjectId(item.mediaId));
  });

  it("does not upscale a smaller-than-target image", async () => {
    const admin = await makeUser("admin");
    const buf = await jpegBuffer(120, 90); // smaller than the 300px thumbnail target

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, "tiny.jpg");

    expect(res.status).toBe(201);
    const item = res.body.data[0];
    createdMediaIds.push(new mongoose.Types.ObjectId(item.mediaId));
    const doc = await Media.findById(item.mediaId).lean();
    expect(doc?.variants?.thumbnail.width).toBe(120);
    expect(doc?.variants?.optimized.width).toBe(120);
  });

  it("uploads a valid PDF, extracts page count, and never invokes image variants", async () => {
    const admin = await makeUser("admin");
    const buf = minimalPdfBuffer();

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, "doc.pdf");

    expect(res.status).toBe(201);
    const item = res.body.data[0];
    createdMediaIds.push(new mongoose.Types.ObjectId(item.mediaId));

    expect(item.mediaType).toBe("DOCUMENT");
    expect(item.mimeType).toBe("application/pdf");
    expect(item.thumbnailUrl).toBeUndefined();
    expect(item.pageCount).toBe(1);

    const doc = await Media.findById(item.mediaId).lean();
    expect(doc?.variants).toBeUndefined();
    expect(fs.existsSync(path.join(getMediaRoot(), doc!.storageKey))).toBe(true);
  });

  it("rejects a renamed file whose content doesn't match any accepted signature", async () => {
    const admin = await makeUser("admin");
    const fakeImage = Buffer.from("this is just plain text, not an image at all");

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", fakeImage, "totally-legit.jpg");

    expect(res.status).toBe(400);
    expect(res.body.errors[0].originalName).toBe("totally-legit.jpg");
  });

  it("rejects a garbage file claiming to be a PDF", async () => {
    const admin = await makeUser("admin");
    const fake = Buffer.from("MZ\x90\x00 not a real pdf");

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", fake, "malicious.pdf");

    expect(res.status).toBe(400);
  });

  it("rejects an oversized image before any processing", async () => {
    const admin = await makeUser("admin");
    // Valid JPEG signature + padding past the 10MB image limit. Rejected on
    // size before ever reaching Sharp, so it doesn't need to be a real image.
    const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(11 * 1024 * 1024)]);

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", oversized, "huge.jpg");

    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/maximum allowed size/i);
  });

  it("rejects an oversized PDF before any processing", async () => {
    const admin = await makeUser("admin");
    // Exceeds MAX_PDF_FILE_SIZE_MB — since that's also the larger of the two
    // per-type limits, Multer's own combined cap catches this first (same
    // outcome, a 400 with a size-related message, via a different layer).
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(21 * 1024 * 1024),
      Buffer.from("%%EOF"),
    ]);

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", oversized, "huge.pdf");

    expect(res.status).toBe(400);
    const message = res.body.errors?.[0]?.message ?? res.body.message;
    expect(message).toMatch(/maximum allowed size|exceed/i);
  });

  it("rejects a request with more than the configured max files per request", async () => {
    const admin = await makeUser("admin");
    const buf = await jpegBuffer(50, 50);

    let req = request(app).post("/api/admin/media/upload").set("Cookie", authCookie(admin));
    for (let i = 0; i < 11; i++) {
      req = req.attach("files", buf, `f${i}.jpg`);
    }
    const res = await req;

    expect(res.status).toBe(400);
  });

  it("processes files independently — one bad file doesn't fail the whole batch", async () => {
    const admin = await makeUser("admin");
    const good = await jpegBuffer(100, 100);
    const bad = Buffer.from("not an image");

    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", good, "good.jpg")
      .attach("files", bad, "bad.jpg");

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.errors).toHaveLength(1);
    createdMediaIds.push(new mongoose.Types.ObjectId(res.body.data[0].mediaId));
  });
});

describe("Media detail / update / delete (integration)", () => {
  it("returns 404 for a malformed id (not a raw cast error)", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .get("/api/admin/media/not-a-valid-id")
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a well-formed but nonexistent id (IDOR check)", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .get(`/api/admin/media/${new mongoose.Types.ObjectId().toString()}`)
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(404);
  });

  it("PATCH updates altText and silently strips forbidden fields", async () => {
    const admin = await makeUser("admin");
    const buf = await jpegBuffer(100, 100);
    const uploadRes = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, "editme.jpg");
    const mediaId = uploadRes.body.data[0].mediaId;
    createdMediaIds.push(new mongoose.Types.ObjectId(mediaId));

    const res = await request(app)
      .patch(`/api/admin/media/${mediaId}`)
      .set("Cookie", authCookie(admin))
      .send({ altText: "A product photo", storageKey: "images/hacked/x", uploadedBy: "someone-else" });

    expect(res.status).toBe(200);
    expect(res.body.data.media.altText).toBe("A product photo");

    const fresh = await Media.findById(mediaId).lean();
    expect(fresh?.storageKey).not.toBe("images/hacked/x");
    expect(fresh?.uploadedBy.toString()).toBe(admin._id.toString());
  });

  it("DELETE removes both the physical file(s) and the database record", async () => {
    const admin = await makeUser("admin");
    const buf = await jpegBuffer(100, 100);
    const uploadRes = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, "deleteme.jpg");
    const mediaId = uploadRes.body.data[0].mediaId;

    const before = await Media.findById(mediaId).lean();
    const keys = Object.values(before!.variants!).map((v) => v.key);
    for (const key of keys) {
      expect(fs.existsSync(path.join(getMediaRoot(), key))).toBe(true);
    }

    const res = await request(app)
      .delete(`/api/admin/media/${mediaId}`)
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(200);

    for (const key of keys) {
      expect(fs.existsSync(path.join(getMediaRoot(), key))).toBe(false);
    }
    expect(await Media.findById(mediaId).lean()).toBeNull();
  });

  it("DELETE returns 404 for a nonexistent id", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .delete(`/api/admin/media/${new mongoose.Types.ObjectId().toString()}`)
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(404);
  });
});

describe("Media reuse & reference safety (integration)", () => {
  async function upload(admin: Awaited<ReturnType<typeof makeUser>>, name: string, buf: Buffer) {
    const res = await request(app)
      .post("/api/admin/media/upload")
      .set("Cookie", authCookie(admin))
      .attach("files", buf, name);
    const item = res.body.data[0];
    createdMediaIds.push(new mongoose.Types.ObjectId(item.mediaId));
    return item as { mediaId: string; deduped?: boolean };
  }

  it("dedupes a byte-identical re-upload to the existing asset (§17)", async () => {
    const admin = await makeUser("admin");
    const buf = await jpegBuffer(240, 180);

    const first = await upload(admin, "dup-a.jpg", buf);
    const second = await upload(admin, "dup-b.jpg", buf);

    expect(second.mediaId).toBe(first.mediaId);
    expect(second.deduped).toBe(true);
  });

  it("blocks deletion while the asset is referenced, then allows it once detached (§10)", async () => {
    const admin = await makeUser("admin");
    const { mediaId } = await upload(admin, "shared.jpg", await jpegBuffer(200, 200));
    const entityId = new mongoose.Types.ObjectId().toString();

    await attachMediaToEntity(mediaId, "PRODUCT", entityId, { field: "gallery" });

    const blocked = await request(app)
      .delete(`/api/admin/media/${mediaId}`)
      .set("Cookie", authCookie(admin));
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.usageCount).toBe(1);

    const usagesRes = await request(app)
      .get(`/api/admin/media/${mediaId}/usages`)
      .set("Cookie", authCookie(admin));
    expect(usagesRes.status).toBe(200);
    expect(usagesRes.body.data.usages).toHaveLength(1);
    expect(usagesRes.body.data.usages[0].entityType).toBe("PRODUCT");

    await detachMedia(mediaId, { entityType: "PRODUCT", entityId });

    const ok = await request(app)
      .delete(`/api/admin/media/${mediaId}`)
      .set("Cookie", authCookie(admin));
    expect(ok.status).toBe(200);
    expect(await Media.findById(mediaId).lean()).toBeNull();
  });

  it("cleanup does not reclaim an asset that still has a usage row", async () => {
    const admin = await makeUser("admin");
    const doc = await Media.create({
      mediaType: "DOCUMENT",
      storageProvider: "local",
      storageKey: `documents/test/${RUN_ID}-referenced.pdf`,
      originalName: "referenced.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      size: 100,
      status: "TEMPORARY",
      uploadedBy: admin._id,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    createdMediaIds.push(doc._id);
    await attachMediaToEntity(doc._id.toString(), "BLOG", new mongoose.Types.ObjectId().toString(), {
      field: "body",
    });

    await cleanupExpiredTemporaryMedia();

    const fresh = await Media.findById(doc._id).lean();
    expect(fresh).not.toBeNull();
    expect(fresh?.status).toBe("ATTACHED");
  });
});

describe("Temporary media cleanup (unit)", () => {
  it("purges expired TEMPORARY media and preserves recent ones", async () => {
    const admin = await makeUser("admin");
    const expired = await Media.create({
      mediaType: "DOCUMENT",
      storageProvider: "local",
      storageKey: `documents/test/${RUN_ID}-expired.pdf`,
      originalName: "expired.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      size: 100,
      status: "TEMPORARY",
      uploadedBy: admin._id,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48h ago, past the 24h TTL
    });
    const recent = await Media.create({
      mediaType: "DOCUMENT",
      storageProvider: "local",
      storageKey: `documents/test/${RUN_ID}-recent.pdf`,
      originalName: "recent.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      size: 100,
      status: "TEMPORARY",
      uploadedBy: admin._id,
    });
    createdMediaIds.push(recent._id);

    await cleanupExpiredTemporaryMedia();

    expect(await Media.findById(expired._id).lean()).toBeNull();
    expect(await Media.findById(recent._id).lean()).not.toBeNull();
  });
});
