import { RequestHandler, Router } from "express";
import { validateBody, locationLimiter, publicCache } from "../../common/middleware";
import { reverseSchema } from "./location.validation";
import {
  reverseHandler,
  searchHandler,
  ipHandler,
  serviceabilityHandler,
} from "./location.controller";

// Unauthenticated storefront helper for the "detect / choose your delivery
// area" feature. This module is the ONLY thing in the app that talks to a
// geocoding provider, so no API key or raw coordinate ever reaches the
// browser. Mounted at /api/location (see routes/index.ts).
const router = Router();

router.use(locationLimiter);

// City/PIN lookups are the same for everyone → shareable cache. `/reverse`
// carries a user's precise position and `/ip` is derived from the caller's
// address, so both are explicitly uncacheable.
const noStore: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

router.post("/reverse", noStore, validateBody(reverseSchema), reverseHandler);
router.get("/search", publicCache, searchHandler);
router.get("/ip", noStore, ipHandler);
router.get("/serviceability", publicCache, serviceabilityHandler);

export default router;
