import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

vi.mock("../../../config/env", () => ({ env: { jwtSecret: "isolated-test-secret", cookieName: "session" } }));
const state = vi.hoisted(() => ({ user: { role: "admin", isActive: true, tokenVersion: 1 } }));
vi.mock("../../../database/models", () => ({ User: { findById: () => ({
  select: () => ({ lean: async () => state.user }), exec: async () => state.user,
}) } }));
import { issueNotificationToken, verifyNotificationToken } from "../token";
import routes from "../notification.routes";
const app = express();
app.use(cookieParser());
app.use(routes);
app.use((err: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.statusCode || 500).json({ message: err.message }));
const session = () => `session=${jwt.sign({ sub: "test-admin", tv: 1 }, "isolated-test-secret")}`;

beforeEach(() => { state.user = { role: "admin", isActive: true, tokenVersion: 1 }; vi.useRealTimers(); });
describe("notification tickets", () => {
  it("issues only to an authenticated admin and prevents caching", async () => {
    const res = await request(app).post("/token").set("Cookie", session());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(verifyNotificationToken(res.body.data.token)).toEqual({ sub: "test-admin", tv: 1 });
  });
  it("rejects missing login", async () => {
    const res = await request(app).post("/token");
    expect(res.status).toBe(401);
  });
  it("rejects non-admin users", async () => {
    state.user.role = "user";
    expect((await request(app).post("/token").set("Cookie", session())).status).toBe(403);
  });
  it("rejects revoked sessions", async () => {
    state.user.tokenVersion = 2;
    expect((await request(app).post("/token").set("Cookie", session())).status).toBe(401);
  });
  it("expires after two minutes and cannot be used as a login JWT", () => {
    vi.useFakeTimers();
    const token = issueNotificationToken("test-admin", 1);
    expect(() => jwt.verify(token, "isolated-test-secret")).toThrow();
    expect(() => verifyNotificationToken(jwt.sign({ sub: "test-admin", tv: 1 }, "isolated-test-secret"))).toThrow();
    vi.advanceTimersByTime(121000);
    expect(() => verifyNotificationToken(token)).toThrow();
    vi.useRealTimers();
  });
});
