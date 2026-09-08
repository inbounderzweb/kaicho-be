import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  createInstagramPostSchema,
  updateInstagramPostSchema,
  updateInstagramPostStatusSchema,
} from "./instagramPost.validation";
import {
  listInstagramPostsHandler,
  getInstagramPostHandler,
  createInstagramPostHandler,
  updateInstagramPostHandler,
  updateInstagramPostStatusHandler,
  deleteInstagramPostHandler,
} from "./instagramPost.controller";

// Admin-only. Same guard chain as every other /admin/* router — no bespoke
// auth. Every mutation is authorised server-side regardless of what the UI
// shows (spec §14).
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listInstagramPostsHandler);
router.post("/", validateBody(createInstagramPostSchema), createInstagramPostHandler);
router.get("/:id", getInstagramPostHandler);
router.patch("/:id", validateBody(updateInstagramPostSchema), updateInstagramPostHandler);
router.patch(
  "/:id/status",
  validateBody(updateInstagramPostStatusSchema),
  updateInstagramPostStatusHandler
);
// Soft delete (archive) — see instagramPost.service.archiveInstagramPost.
router.delete("/:id", deleteInstagramPostHandler);

export default router;
