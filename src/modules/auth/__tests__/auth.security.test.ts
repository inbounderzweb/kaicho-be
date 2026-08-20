import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User } from "../../../database/models";
import { requireAuth } from "../../../common/middleware/requireAuth";
import { requireRole } from "../../../common/middleware/requireRole";
import { signSessionToken } from "../auth.service";
import type { Request, Response, NextFunction } from "express";

// Unique per test-file run so re-runs (and the manually-driven dev server)
// never collide on the same phone/OTP-rate-limit bucket.
const RUN_ID = Date.now().toString().slice(-8);
const createdUserIds: mongoose.Types.ObjectId[] = [];

async function makeTestUser(overrides: Partial<{
  role: "user" | "admin";
  isActive: boolean;
  tokenVersion: number;
}> = {}) {
  const user = await User.create({
    phone: `9${RUN_ID}${createdUserIds.length}`.slice(0, 10),
    countryCode: "+91",
    phoneVerified: true,
    role: overrides.role ?? "user",
    isActive: overrides.isActive ?? true,
    tokenVersion: overrides.tokenVersion ?? 0,
  });
  createdUserIds.push(user._id);
  return user;
}

function mockRes() {
  return {} as Response;
}

function mockReq(overrides: Partial<Request> = {}) {
  return { cookies: {}, ...overrides } as unknown as Request;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("requireAuth middleware (unit)", () => {
  it("calls next() with no error for a valid, current token", async () => {
    const user = await makeTestUser();
    const token = signSessionToken(user);
    let nextArg: unknown = "not-called";
    await requireAuth(mockReq({ cookies: { kaicho_session: token } }), mockRes(), ((arg?: unknown) => {
      nextArg = arg;
    }) as NextFunction);
    expect(nextArg).toBeUndefined();
  });

  it("rejects with 401 when no cookie is present", async () => {
    let error: { statusCode?: number } = {};
    await requireAuth(mockReq({ cookies: {} }), mockRes(), ((arg: unknown) => {
      error = arg as { statusCode?: number };
    }) as NextFunction);
    expect(error.statusCode).toBe(401);
  });

  it("rejects with 401 after tokenVersion is bumped server-side (logout revocation)", async () => {
    const user = await makeTestUser();
    const token = signSessionToken(user); // tv: 0
    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } }); // simulate logout

    let error: { statusCode?: number } = {};
    await requireAuth(mockReq({ cookies: { kaicho_session: token } }), mockRes(), ((arg: unknown) => {
      error = arg as { statusCode?: number };
    }) as NextFunction);
    expect(error.statusCode).toBe(401);
  });

  it("rejects with 401 for a disabled account, even with an otherwise-valid token", async () => {
    const user = await makeTestUser({ isActive: false });
    const token = signSessionToken(user);

    let error: { statusCode?: number } = {};
    await requireAuth(mockReq({ cookies: { kaicho_session: token } }), mockRes(), ((arg: unknown) => {
      error = arg as { statusCode?: number };
    }) as NextFunction);
    expect(error.statusCode).toBe(401);
  });
});

describe("requireRole middleware (unit)", () => {
  it("calls next() with no error when the user's current role is allowed", async () => {
    const user = await makeTestUser({ role: "admin" });
    let nextArg: unknown = "not-called";
    await requireRole("admin")(mockReq({ userId: user._id.toString() }), mockRes(), ((arg?: unknown) => {
      nextArg = arg;
    }) as NextFunction);
    expect(nextArg).toBeUndefined();
  });

  it("rejects with 403 when the user's current role is not allowed", async () => {
    const user = await makeTestUser({ role: "user" });
    let error: { statusCode?: number } = {};
    await requireRole("admin")(mockReq({ userId: user._id.toString() }), mockRes(), ((arg: unknown) => {
      error = arg as { statusCode?: number };
    }) as NextFunction);
    expect(error.statusCode).toBe(403);
  });

  it("reflects a role downgrade immediately (reads live from the DB, not from the token)", async () => {
    const user = await makeTestUser({ role: "admin" });
    const middleware = requireRole("admin");

    let firstResult: unknown = "not-called";
    await middleware(mockReq({ userId: user._id.toString() }), mockRes(), ((arg?: unknown) => {
      firstResult = arg;
    }) as NextFunction);
    expect(firstResult).toBeUndefined(); // still admin: allowed

    await User.updateOne({ _id: user._id }, { role: "user" }); // downgrade

    let secondResult: { statusCode?: number } = {};
    await middleware(mockReq({ userId: user._id.toString() }), mockRes(), ((arg: unknown) => {
      secondResult = arg as { statusCode?: number };
    }) as NextFunction);
    expect(secondResult.statusCode).toBe(403); // same middleware instance, no re-login
  });
});

describe("Full HTTP flow: login -> logout -> replay old cookie (F-01 regression)", () => {
  const phone = `8${RUN_ID}9`.slice(0, 10);

  it("logs in via the real OTP flow, then confirms the old cookie is rejected after logout", async () => {
    // ConsoleSmsProvider logs the plaintext OTP in development (the same
    // channel used for manual testing throughout this project) - spy on it
    // to drive the real HTTP endpoints exactly as a client would.
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const sendRes = await request(app).post("/api/auth/send-otp").send({ phone });
    console.log = originalLog;
    expect(sendRes.status).toBe(200);

    const line = logs.find((l) => l.includes(phone) && l.includes("verification code"));
    const otp = /->\s*(\d{4})\s+is your Kaicho/.exec(line ?? "")?.[1];
    expect(otp).toBeTruthy();

    const verifyRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone, otp });
    expect(verifyRes.status).toBe(200);

    const setCookie = verifyRes.headers["set-cookie"]?.[0] ?? "";
    const token = /kaicho_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(token).toBeTruthy();

    const meRes = await request(app).get("/api/auth/me").set("Cookie", `kaicho_session=${token}`);
    expect(meRes.status).toBe(200);

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `kaicho_session=${token}`);
    expect(logoutRes.status).toBe(200);

    // The core regression test: replaying the OLD token after logout must
    // now be rejected. Before the requireAuth.ts fix, this returned 200.
    const replayRes = await request(app).get("/api/auth/me").set("Cookie", `kaicho_session=${token}`);
    expect(replayRes.status).toBe(401);

    createdUserIds.push(...(await User.find({ phone }).distinct("_id")));
  });
});
