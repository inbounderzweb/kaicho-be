import crypto from "crypto";
import { Request, Response } from "express";
import { env } from "../../config/env";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Meta's one-time handshake when you click "Verify and save": echo
// hub.challenge back as plain text iff the verify token matches.
export function verifyWebhook(req: Request, res: Response): void {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (
    env.whatsappVerifyToken &&
    mode === "subscribe" &&
    typeof token === "string" &&
    safeEqual(token, env.whatsappVerifyToken)
  ) {
    res.status(200).type("text/plain").send(String(challenge));
    return;
  }
  res.sendStatus(403);
}

// Incoming messages + status updates. Authenticity = HMAC-SHA256 of the raw
// body keyed with the app secret (same raw-body approach as the Razorpay
// webhook). Always 200 quickly once verified so Meta doesn't retry.
export function receiveWebhook(req: Request, res: Response): void {
  const header = req.get("x-hub-signature-256") ?? "";
  if (!env.whatsappAppSecret || !req.rawBody) {
    res.sendStatus(403);
    return;
  }
  const expected =
    "sha256=" + crypto.createHmac("sha256", env.whatsappAppSecret).update(req.rawBody).digest("hex");
  if (!safeEqual(header, expected)) {
    res.sendStatus(403);
    return;
  }

  // TODO: persist/route events. For now just log a summary.
  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      for (const m of v.messages ?? []) console.log(`[whatsapp] message from ${m.from} (${m.type})`);
      for (const s of v.statuses ?? []) console.log(`[whatsapp] status ${s.id} -> ${s.status}`);
    }
  }
  res.sendStatus(200);
}
