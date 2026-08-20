import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createCategorySchema, updateCategorySchema } from "./category.validation";
import {
  createCategoryHandler,
  getCategoryListHandler,
  getCategoryOptionsHandler,
  getCategoryDetailHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
} from "./category.controller";

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

export default router;
