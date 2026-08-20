import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createBrandSchema, updateBrandSchema } from "./brand.validation";
import {
  createBrandHandler,
  getBrandListHandler,
  getBrandOptionsHandler,
  getBrandDetailHandler,
  updateBrandHandler,
  deleteBrandHandler,
} from "./brand.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

// /options must precede /:id — same ordering lesson as category.routes.ts:
// otherwise Express would treat "options" as an :id.
router.get("/options", getBrandOptionsHandler);

router.post("/", validateBody(createBrandSchema), createBrandHandler);
router.get("/", getBrandListHandler);
router.get("/:id", getBrandDetailHandler);
router.patch("/:id", validateBody(updateBrandSchema), updateBrandHandler);
router.delete("/:id", deleteBrandHandler);

export default router;
