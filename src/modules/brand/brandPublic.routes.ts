import { Router } from "express";
import { getPublicBrandListHandler } from "./brandPublic.controller";

// Unauthenticated, separate from brand.routes.ts (admin CRUD, mounted at
// /admin/brands) — see productPublic.routes.ts for the same pattern.
const router = Router();

router.get("/", getPublicBrandListHandler);

export default router;
