import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { savePageContentSchema } from "./seoContent.validation";
import {
  listPagesHandler,
  listEntitiesHandler,
  getStaticHandler,
  saveStaticHandler,
  getEntityHandler,
  saveEntityHandler,
} from "./seoContent.controller";

// Admin SEO Management. Same guard chain as every other /admin/* router.
// Entity routes are declared first so "/entities/..." never matches the
// static "/pages/:pageType" shape.
const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/pages", listPagesHandler);
router.get("/pages/:pageType", getStaticHandler);
router.put("/pages/:pageType", validateBody(savePageContentSchema), saveStaticHandler);
router.get("/entities/:pageType", listEntitiesHandler);
router.get("/entities/:pageType/:entityId", getEntityHandler);
router.put("/entities/:pageType/:entityId", validateBody(savePageContentSchema), saveEntityHandler);

export default router;
