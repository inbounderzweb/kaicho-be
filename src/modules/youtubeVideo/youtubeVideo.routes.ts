import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  createYouTubeVideoSchema,
  updateYouTubeVideoSchema,
  updateYouTubeVideoStatusSchema,
} from "./youtubeVideo.validation";
import {
  listYouTubeVideosHandler,
  getYouTubeVideoHandler,
  createYouTubeVideoHandler,
  updateYouTubeVideoHandler,
  updateYouTubeVideoStatusHandler,
  deleteYouTubeVideoHandler,
} from "./youtubeVideo.controller";

// Admin-only. Same guard chain as every other /admin/* router.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listYouTubeVideosHandler);
router.post("/", validateBody(createYouTubeVideoSchema), createYouTubeVideoHandler);
router.get("/:id", getYouTubeVideoHandler);
router.patch("/:id", validateBody(updateYouTubeVideoSchema), updateYouTubeVideoHandler);
router.patch(
  "/:id/status",
  validateBody(updateYouTubeVideoStatusSchema),
  updateYouTubeVideoStatusHandler
);
// Soft delete (archive).
router.delete("/:id", deleteYouTubeVideoHandler);

export default router;
