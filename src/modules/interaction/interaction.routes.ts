import { Router } from "express";
import { requireAuth, requireRole, validateBody, interactionLimiter } from "../../common/middleware";
import { interactionContext } from "./interaction.context";
import { recordInteractionsSchema, trackingConsentSchema } from "./interaction.validation";
import {
  recordInteractionsHandler,
  getConsentHandler,
  setConsentHandler,
  getHistoryHandler,
  deleteDataHandler,
  statsHandler,
} from "./interaction.controller";

// Every route is authenticated (see below) and scoped to req.userId - there is no
// endpoint that takes a user id, so one user can never read another's data.
// Admin-facing aggregate analytics will mount separately.
const router = Router();

// requireAuth is per-route, NOT router.use(): this router is mounted at "/"
// so a router-level guard would also demand a login for every public route
// mounted after it.
router.post("/interactions", requireAuth, interactionContext, interactionLimiter, validateBody(recordInteractionsSchema), recordInteractionsHandler);
router.get("/me/tracking-consent", requireAuth, getConsentHandler);
router.put("/me/tracking-consent", requireAuth, validateBody(trackingConsentSchema), setConsentHandler);
router.get("/me/interaction-history", requireAuth, getHistoryHandler);
router.delete("/me/interaction-data", requireAuth, deleteDataHandler);

// Ingestion health for operators: accepted / written / duplicates / dropped /
// flush failures / buffer depth (this process only).
router.get("/admin/interaction-stats", requireAuth, requireRole("admin"), statsHandler);

export default router;
