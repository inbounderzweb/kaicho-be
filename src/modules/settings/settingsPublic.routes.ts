import { Router } from "express";
import { getPublicStoreSettingsHandler } from "./settings.controller";

// Unauthenticated — the storefront cart reads the shipping policy (free-
// delivery threshold, flat fee) from here to render its "add ₹X more"
// nudge. Separate from settings.routes.ts (admin), same pattern as
// brandPublic.routes.ts / productPublic.routes.ts.
const router = Router();

router.get("/", getPublicStoreSettingsHandler);

export default router;
