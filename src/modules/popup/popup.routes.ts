import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createPopupSchema, updatePopupSchema, updatePopupStatusSchema } from "./popup.validation";
import {
  listPopupsHandler,
  getPopupHandler,
  createPopupHandler,
  updatePopupHandler,
  updatePopupStatusHandler,
  deletePopupHandler,
} from "./popup.controller";

// Admin-only, same guard chain as every other /admin/* router.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listPopupsHandler);
router.post("/", validateBody(createPopupSchema), createPopupHandler);
router.get("/:id", getPopupHandler);
router.patch("/:id", validateBody(updatePopupSchema), updatePopupHandler);
router.patch("/:id/status", validateBody(updatePopupStatusSchema), updatePopupStatusHandler);
router.delete("/:id", deletePopupHandler);

export default router;
