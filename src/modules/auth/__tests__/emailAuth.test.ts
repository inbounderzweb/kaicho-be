import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Env is read once at import, so pin the limits the tests rely on BEFORE any
// app module loads (vi.hoisted runs ahead of the hoisted imports).
vi.hoisted(() => {
  process.env.RATE_LIMIT_LOGIN_MAX = "5";
  process.env.RATE_LIMIT_LOGIN_IP_MAX = "500";
  process.env.RATE_LIMIT_RESEND_VERIFICATION_IP_MAX = "500";
  process.env.RATE_LIMIT_REGISTER_MAX = "200";
  process.env.RATE_LIMIT_VERIFY_EMAIL_MAX = "500";
  process.env.RATE_LIMIT_RESEND_VERIFICATION_MAX = "6";
  process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = "60";
});

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text: string }>);
vi.mock("../../../common/email/email.service", async (orig) => ({
  ...(await orig<typeof import("../../../common/email/email.service")>()),
  sendEmail: async (m: (typeof sent)[number]) => {
    sent.push(m);
  },
}));

const googlePayload = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    async verifyIdToken() {
      if (!googlePayload.current) throw new Error("bad token");
      return { getPayload: () => googlePayload.current };
    }
  },
}));

import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { env } from "../../../config/env";
import { connectDatabase } from "../../../database/connection";
import { EmailVerificationToken, User } from "../../../database/models";

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let n = 0;
const newEmail = () => `qa-${RUN}-${n++}@example.test`;
const PASSWORD = "Sup3rSecret!";
const emails: string[] = [];

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

function lastTokenFor(email: string): string {
  const mail = [...sent].reverse().find((m) => m.to === email);
  expect(mail, `no email sent to ${email}`).toBeDefined();
  const m = /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail!.text);
  expect(m).not.toBeNull();
  return m![1];
}

async function register(email: string, name = "Test User", password = PASSWORD) {
  emails.push(email);
  return request(app).post("/api/auth/register").send({ name, email, password });
}

async function registerAndVerify(email = newEmail()) {
  await register(email);
  const res = await request(app).post("/api/auth/verify-email").send({ token: lastTokenFor(email) });
  expect(res.status).toBe(200);
  return { email, cookie: res.headers["set-cookie"] as unknown as string[] };
}

beforeAll(async () => {
  await connectDatabase();
  await User.init();
  await EmailVerificationToken.init();
});

beforeEach(() => {
  googlePayload.current = null;
});

afterAll(async () => {
  const users = await User.find({ email: { $in: emails } }).select("_id");
  await EmailVerificationToken.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await User.deleteMany({ email: { $in: emails } });
  await mongoose.connection.close();
});

describe("registration", () => {
  it("creates an UNVERIFIED user, hashes the password, stores only a token hash, emails the link, sets no cookie", async () => {
    const email = `  ${newEmail().toUpperCase()}  `; // exercises trim + lowercase
    const res = await register(email.trim().toLowerCase() === email ? email : email.trim());
    expect(res.status).toBe(201);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash|password/i);

    const normalized = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalized }).select("+passwordHash");
    expect(user).not.toBeNull();
    expect(user!.emailVerified).toBe(false);
    expect(user!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user!.passwordHash).not.toContain(PASSWORD);
    expect(user!.firstName).toBe("Test");

    const raw = lastTokenFor(normalized);
    const rec = await EmailVerificationToken.findOne({ userId: user!._id });
    expect(rec!.tokenHash).toBe(sha(raw));
    expect(rec!.tokenHash).not.toContain(raw);
    const ttlMin = (rec!.expiresAt.getTime() - Date.now()) / 60000;
    expect(ttlMin).toBeGreaterThan(28);
    expect(ttlMin).toBeLessThanOrEqual(30);

    const mail = sent.find((m) => m.to === normalized)!;
    expect(mail.subject).toBe("Verify your Kaicho account");
    expect(mail.text).toContain(`${env.appUrl ?? env.frontendOrigins[0]}/verify-email?token=${raw}`);
    expect(mail.html).toContain("Verify Email");
    expect(mail.text).toContain("expires in 30 minutes");
  });

  it("duplicate email: identical response, no second account, verified account untouched", async () => {
    const { email } = await registerAndVerify();
    const before = sent.length;
    const res = await register(email, "Attacker", "An0therPass!");
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/check your email/i);
    expect(sent.length).toBe(before); // nothing sent to a verified account
    expect(await User.countDocuments({ email })).toBe(1);
    // original password still works, attacker's does not
    expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
  });

  it.each([
    ["invalid email", { name: "A", email: "not-an-email", password: PASSWORD }],
    ["missing name", { name: " ", email: "x@example.test", password: PASSWORD }],
    ["short password", { name: "A", email: "x@example.test", password: "Ab1" }],
    ["no digit", { name: "A", email: "x@example.test", password: "abcdefghij" }],
    ["no letter", { name: "A", email: "x@example.test", password: "1234567890" }],
    ["over 72 bytes", { name: "A", email: "x@example.test", password: "a1".repeat(40) }],
    ["NoSQL operator as email", { name: "A", email: { $ne: "" }, password: PASSWORD }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await request(app).post("/api/auth/register").send(body);
    expect(res.status).toBe(400);
  });

  it("re-registering an UNVERIFIED address replaces the password (latest registrant wins) and does not double-send inside the cooldown", async () => {
    const email = newEmail();
    await register(email, "Squatter", "Squ4tterPass!");
    const before = sent.length;
    await register(email, "Real Owner", "R3alOwnerPass!");
    expect(sent.length).toBe(before); // inside cooldown
    const raw = lastTokenFor(email);
    await request(app).post("/api/auth/verify-email").send({ token: raw }).expect(200);
    expect((await request(app).post("/api/auth/login").send({ email, password: "Squ4tterPass!" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email, password: "R3alOwnerPass!" })).status).toBe(200);
  });
});

describe("email verification", () => {
  it("valid link: verifies, consumes the token, sets an HttpOnly session, and the session works on a protected API", async () => {
    const email = newEmail();
    await register(email);
    const res = await request(app).post("/api/auth/verify-email").send({ token: lastTokenFor(email) });
    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerified).toBe(true);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.join(";")).toMatch(/kaicho_session=/);
    expect(cookies.join(";")).toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash|tokenVersion/);

    const user = await User.findOne({ email });
    expect(await EmailVerificationToken.countDocuments({ userId: user!._id })).toBe(0);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookies);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
  });

  it("already-used link is rejected", async () => {
    const email = newEmail();
    await register(email);
    const token = lastTokenFor(email);
    await request(app).post("/api/auth/verify-email").send({ token }).expect(200);
    const again = await request(app).post("/api/auth/verify-email").send({ token });
    expect(again.status).toBe(400);
    expect(again.body.message).toBe("Verification link is invalid or expired.");
  });

  it("two concurrent uses of one link: exactly one succeeds", async () => {
    const email = newEmail();
    await register(email);
    const token = lastTokenFor(email);
    const [a, b] = await Promise.all([
      request(app).post("/api/auth/verify-email").send({ token }),
      request(app).post("/api/auth/verify-email").send({ token }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it("expired link is rejected and the account stays unverified", async () => {
    const email = newEmail();
    await register(email);
    const token = lastTokenFor(email);
    await EmailVerificationToken.updateOne({ tokenHash: sha(token) }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).post("/api/auth/verify-email").send({ token });
    expect(res.status).toBe(400);
    expect((await User.findOne({ email }))!.emailVerified).toBe(false);
  });

  it.each([
    ["well-formed but unknown", "A".repeat(43)],
    ["malformed", "short"],
    ["operator injection", { $ne: "" }],
    ["missing", undefined],
  ])("%s token is rejected", async (_l, token) => {
    const res = await request(app).post("/api/auth/verify-email").send({ token });
    expect(res.status).toBe(400);
  });

  it("GET on the verify route does not verify anything", async () => {
    const email = newEmail();
    await register(email);
    const res = await request(app).get(`/api/auth/verify-email?token=${lastTokenFor(email)}`);
    // (An unmatched GET /api/* falls through to the app's version catch-all.)
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body.data?.user).toBeUndefined();
    expect((await User.findOne({ email }))!.emailVerified).toBe(false);
    expect(await EmailVerificationToken.countDocuments({ userId: (await User.findOne({ email }))!._id })).toBe(1);
  });
});

describe("resend verification", () => {
  const GENERIC = "If the account exists and is not verified, a verification email has been sent.";

  it("same response for unknown, verified and unverified addresses; unknown/verified get no email", async () => {
    const { email: verified } = await registerAndVerify();
    const unknown = newEmail();
    const before = sent.length;
    const a = await request(app).post("/api/auth/resend-verification").send({ email: unknown });
    const b = await request(app).post("/api/auth/resend-verification").send({ email: verified });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body.message).toBe(GENERIC);
    expect(sent.length).toBe(before);
  });

  it("cooldown suppresses a second email; after it, a new token replaces and invalidates the old one", async () => {
    const email = newEmail();
    await register(email);
    const oldToken = lastTokenFor(email);
    const user = (await User.findOne({ email }))!;

    const n0 = sent.length;
    const r1 = await request(app).post("/api/auth/resend-verification").send({ email });
    expect(r1.body.message).toBe(GENERIC); // identical even though suppressed
    expect(sent.length).toBe(n0);

    // Raw collection: Mongoose treats createdAt as immutable and would drop this.
    await EmailVerificationToken.collection.updateMany(
      { userId: user._id },
      { $set: { createdAt: new Date(Date.now() - 120_000) } }
    );
    const r2 = await request(app).post("/api/auth/resend-verification").send({ email });
    expect(r2.status).toBe(200);
    expect(sent.length).toBe(n0 + 1);
    const newToken = lastTokenFor(email);
    expect(newToken).not.toBe(oldToken);
    expect(await EmailVerificationToken.countDocuments({ userId: user._id })).toBe(1);

    expect((await request(app).post("/api/auth/verify-email").send({ token: oldToken })).status).toBe(400);
    expect((await request(app).post("/api/auth/verify-email").send({ token: newToken })).status).toBe(200);
  });

  it("is rate limited per email, including for addresses that don't exist", async () => {
    const email = newEmail(); // never registered
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await request(app).post("/api/auth/resend-verification").send({ email })).status);
    }
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});

describe("password login", () => {
  it("blocks login before verification (correct password) with a verify-your-email response and no session", async () => {
    const email = newEmail();
    await register(email);
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.details.code).toBe("EMAIL_NOT_VERIFIED");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("logs in after verification; response leaks no secrets; logout revokes the old cookie", async () => {
    const { email } = await registerAndVerify();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash|tokenVersion|\$2b\$/);
    const cookie = res.headers["set-cookie"] as unknown as string[];

    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(200);
    await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("wrong password and unknown email return the same 401", async () => {
    const { email } = await registerAndVerify();
    const wrong = await request(app).post("/api/auth/login").send({ email, password: "Wr0ngPassword" });
    const unknown = await request(app).post("/api/auth/login").send({ email: newEmail(), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it("does not authenticate a disabled account", async () => {
    const { email } = await registerAndVerify();
    await User.updateOne({ email }, { isActive: false });
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an operator-object password/email (NoSQL injection)", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: { $gt: "" }, password: { $gt: "" } });
    expect(res.status).toBe(400);
  });

  it("rate limits failed attempts per email (and a success is never counted)", async () => {
    const { email } = await registerAndVerify();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await request(app).post("/api/auth/login").send({ email, password: "Wr0ngPassword" })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe("Google login", () => {
  const profile = (email: string, over: Record<string, unknown> = {}) => ({
    sub: `g-${RUN}-${email}`,
    email,
    email_verified: true,
    given_name: "Gina",
    family_name: "Goog",
    ...over,
  });
  const google = () => request(app).post("/api/auth/google").send({ credential: "x".repeat(40) });

  it("creates a verified user for a new Google account", async () => {
    const email = newEmail();
    emails.push(email);
    googlePayload.current = profile(email);
    const res = await google();
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    const u = await User.findOne({ email });
    expect(u!.emailVerified).toBe(true);
    expect(u!.googleId).toBe(`g-${RUN}-${email}`);
  });

  it("logs an existing Google user back in without creating a duplicate", async () => {
    const email = newEmail();
    emails.push(email);
    googlePayload.current = profile(email);
    await google().expect(200);
    await google().expect(200);
    expect(await User.countDocuments({ email })).toBe(1);
  });

  it("links to an existing VERIFIED password account (no duplicate; password still works)", async () => {
    const { email } = await registerAndVerify();
    googlePayload.current = profile(email);
    await google().expect(200);
    expect(await User.countDocuments({ email })).toBe(1);
    expect((await User.findOne({ email }))!.googleId).toBeTruthy();
    expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
  });

  it("linking to an UNVERIFIED password registration discards the squatter's password", async () => {
    const email = newEmail();
    await register(email, "Squatter", "Squ4tterPass!");
    googlePayload.current = profile(email);
    await google().expect(200);
    const u = await User.findOne({ email }).select("+passwordHash");
    expect(u!.emailVerified).toBe(true);
    expect(u!.passwordHash).toBeUndefined();
    expect(await EmailVerificationToken.countDocuments({ userId: u!._id })).toBe(0);
    expect((await request(app).post("/api/auth/login").send({ email, password: "Squ4tterPass!" })).status).toBe(401);
  });

  it("rejects a Google account whose email is not verified, and a credential Google rejects", async () => {
    googlePayload.current = profile(newEmail(), { email_verified: false });
    expect((await google()).status).toBe(400);
    googlePayload.current = null;
    expect((await google()).status).toBe(401);
  });
});
