import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import type { TrackContext } from "./interaction.tracking.service";

declare global {
  namespace Express {
    interface Request {
      interaction?: TrackContext;
    }
  }
}

const SAFE_ID = /^[A-Za-z0-9_.-]{8,64}$/;

// Attaches a trusted tracking context to an AUTHENTICATED request: the user
// comes from the verified session (never the body), the consent comes from
// the user row requireAuth already loaded, and the correlation id ties the
// events to the request in logs. Mount it AFTER requireAuth, only on routes
// that record events. It writes nothing itself - events are created at
// business boundaries, not per request - and it does no database work.
export function interactionContext(req: Request, res: Response, next: NextFunction) {
  if (req.userId) {
    const incoming = req.get("x-request-id");
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", correlationId);
    req.interaction = { userId: req.userId, consent: req.trackingConsent ?? null, correlationId };
  }
  next();
}
