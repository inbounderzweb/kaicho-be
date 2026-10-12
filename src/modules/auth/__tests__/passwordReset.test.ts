import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_LOGIN_MAX = "500";
  process.env.RATE_LIMIT_LOGIN_IP_MAX = "500";
  process.env.RATE_LIMIT_REGISTER_MAX = "200";
  process.env.RATE_LIMIT_VERIFY_EMAIL_MAX = "500";
  process.env.RATE_LIMIT_FORGOT_PASSWORD_MAX = "4";
  process.env.RATE_LIMIT_FORGOT_PASSWORD_IP_MAX = "500";
  process.env.RATE_LIMIT_RESET_PASSWORD_MAX = "500";
  process.env.PASSWORD_RESET_COOLDOWN_SECONDS = "60";
});

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text: string }>);
vi.mock("../../../common/email/email.service", async (orig) => ({
  ...(await orig<typeof import("../../../common/email/email.service")>()),
  sendEmail: async (m: (typeof sent)[number]) => {
    sent.push(m);
  },
}));

import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { EmailVerificationToken, PasswordResetToken, User } from "../../../database/models";

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let n = 0;
const newEmail = () => `pr-${RUN}-${n++}@example.test`;
const PASSWORD = "Sup3rSecret!";
const NEW_PASSWORD = "Br4ndNewPass!";
const emails: string[] = [];

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

function lastResetToken(email: string): string {
  const mail = [...sent].reverse().find((m) => m.to === email && /reset/i.test(m.subject));
  expect(mail, `no reset email sent to ${email}`).toBeDefined();
  const m = /reset-password\?token=([A-Za-z0-9_-]{43})/.exec(mail!.text);
  expect(m).not.toBeNull();
  return m![1];
}

async function verifiedUser() {
  const email = newEmail();
  emails.push(email);
  await request(app).post("/api/auth/register").send({ name: "Test User", email, password: PASSWORD });
  const mail = sent.find((m) => m.to === email)!;
  const token = /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1];
  const res = await request(app).post("/api/auth/verify-email").send({ token });
  expect(res.status).toBe(200);
  return { email, cookie: res.headers["set-cookie"] as unknown as string[] };
}

const forgot = (email: string) => request(app).post("/api/auth/forgot-password").send({ email });
const reset = (token: string, password = NEW_PASSWORD) =>
  request(app).post("/api/auth/reset-password").send({ token, password });
const login = (email: string, password: string) =>
  request(app).post("/api/auth/login").send({ email, password });

beforeAll(async () => {
  await connectDatabase();
  await User.init();
  await PasswordResetToken.init();
});

afterAll(async () => {
  const users = await User.find({ email: { $in: emails } }).select("_id");
  const ids = users.map((u) => u._id);
  await PasswordResetToken.deleteMany({ userId: { $in: ids } });
  await EmailVerificationToken.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ email: { $in: emails } });
  await mongoose.connection.close();
});

describe("forgot + reset password", () => {
  it("emails a link, stores only the hash, and the link resets the password once", async () => {
    const { email } = await verifiedUser();
    const res = await forgot(email);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    const raw = lastResetToken(email);
    const user = await User.findOne({ email });
    const rec = await PasswordResetToken.findOne({ userId: user!._id });
    expect(rec!.tokenHash).toBe(sha(raw));

    const ok = await reset(raw);
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]).toBeUndefined(); // does not sign in

    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(email, PASSWORD)).status).toBe(401);

    // single use
    expect((await reset(raw, "An0therPass!")).status).toBe(400);
  });

  it("invalidates existing sessions", async () => {
    const { email, cookie } = await verifiedUser();
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(200);
    await forgot(email);
    expect((await reset(lastResetToken(email))).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("answers identically for unknown and unverified emails and sends nothing", async () => {
    const known = (await verifiedUser()).email;
    const unverified = newEmail();
    emails.push(unverified);
    await request(app).post("/api/auth/register").send({ name: "U", email: unverified, password: PASSWORD });

    const before = sent.length;
    const a = await forgot(newEmail());
    const b = await forgot(unverified);
    const c = await forgot(known);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    expect(sent.length).toBe(before + 1); // only the verified account got mail
  });

  it("respects the resend cooldown", async () => {
    const { email } = await verifiedUser();
    await forgot(email);
    const count = sent.length;
    expect((await forgot(email)).status).toBe(200);
    expect(sent.length).toBe(count);
  });

  it("rejects bad, expired and weak-password requests", async () => {
    const { email } = await verifiedUser();
    await forgot(email);
    const raw = lastResetToken(email);

    expect((await reset("x".repeat(43))).status).toBe(400);
    expect((await reset("short")).status).toBe(400);
    expect((await reset(raw, "short")).status).toBe(400); // weak: token must survive
    expect((await reset(raw, "allletters")).status).toBe(400);

    await PasswordResetToken.updateOne({ tokenHash: sha(raw) }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await reset(raw)).status).toBe(400);
  });

  it("lets an email-less-password (Google-style) verified account set a password", async () => {
    const { email } = await verifiedUser();
    await User.updateOne({ email }, { $unset: { passwordHash: 1 } });
    await forgot(email);
    expect((await reset(lastResetToken(email))).status).toBe(200);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  it("rate-limits forgot-password per email", async () => {
    const email = newEmail();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await forgot(email)).status);
    expect(codes.slice(0, 4).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
