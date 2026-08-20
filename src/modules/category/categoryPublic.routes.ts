import { Router } from "express";
import {
  getPublicCategoryListHandler,
  getPublicCategoryDetailHandler,
  getPublicCategoryProductsHandler,
} from "./categoryPublic.controller";

// Unauthenticated, separate from category.routes.ts (admin CRUD, mounted at
// /admin/categories) — see productPublic.routes.ts for the same pattern.
const router = Router();

router.get("/", getPublicCategoryListHandler);
router.get("/:slug/products", getPublicCategoryProductsHandler);
router.get("/:slug", getPublicCategoryDetailHandler);

export default router;
