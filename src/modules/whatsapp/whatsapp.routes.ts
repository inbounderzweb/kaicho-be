import { Router } from "express";
import { verifyWebhook, receiveWebhook } from "./whatsapp.controller";

const router = Router();

// Called by Meta's servers (no session cookie) — GET is authenticated by the
// verify token, POST by the X-Hub-Signature-256 HMAC. Not rate-limited.
router.get("/webhook", verifyWebhook);
router.post("/webhook", receiveWebhook);

export default router;
