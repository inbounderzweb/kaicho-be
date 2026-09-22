import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createCategorySchema, updateCategorySchema } from "./category.validation";
import {
  createPackSchema,
  updatePackSchema,
  updateCategoryPackConfigSchema,
} from "../product/pack.validation";
import {
  createCategoryHandler,
  getCategoryListHandler,
  getCategoryOptionsHandler,
  getCategoryDetailHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
} from "./category.controller";
import {
  listCategoryPacksHandler,
  createCategoryPackHandler,
  updateCategoryPackHandler,
  deleteCategoryPackHandler,
  getCategoryPackConfigHandler,
  updateCategoryPackConfigHandler,
} from "./pack.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

// /options must precede /:id — same ordering lesson as adminUsers.routes.ts's
// /stats before /:id: otherwise Express would treat "options" as an :id.
router.get("/options", getCategoryOptionsHandler);

router.post("/", validateBody(createCategorySchema), createCategoryHandler);
router.get("/", getCategoryListHandler);
router.get("/:id", getCategoryDetailHandler);
router.patch("/:id", validateBody(updateCategorySchema), updateCategoryHandler);
router.delete("/:id", deleteCategoryHandler);

// Category-level Pack / Combo Configuration (spec §15/§16) — products opt in
// to inheriting this via Product.packConfig.mode === "INHERIT_CATEGORY".
router.get("/:id/pack-config", getCategoryPackConfigHandler);
router.patch("/:id/pack-config", validateBody(updateCategoryPackConfigSchema), updateCategoryPackConfigHandler);
router.get("/:id/packs", listCategoryPacksHandler);
router.post("/:id/packs", validateBody(createPackSchema), createCategoryPackHandler);
router.put("/:id/packs/:packId", validateBody(updatePackSchema), updateCategoryPackHandler);
router.delete("/:id/packs/:packId", deleteCategoryPackHandler);

export default router;
