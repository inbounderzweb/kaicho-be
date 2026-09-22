import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import type { SessionPayload } from "../../common/middleware/requireAuth";

// Separate signing key: a notification ticket must never authenticate an API session.
const key = () => createHmac("sha256", env.jwtSecret).update("kaicho:notification-ticket:v1").digest();
const audience = "kaicho-admin-notifications";
const issuer = "kaicho-api";
export const NOTIFICATION_TOKEN_TTL = 120;

export function issueNotificationToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ tv: tokenVersion }, key(), {
    subject: userId, audience, issuer, algorithm: "HS256", expiresIn: NOTIFICATION_TOKEN_TTL,
  });
}

export function verifyNotificationToken(token: string): SessionPayload {
  const payload = jwt.verify(token, key(), { algorithms: ["HS256"], audience, issuer });
  if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.tv !== "number") {
    throw new Error("Invalid notification token");
  }
  return { sub: payload.sub, tv: payload.tv };
}
