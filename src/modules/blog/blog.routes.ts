import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  createBlogSchema,
  updateBlogSchema,
  blogStatusSchema,
  blogScheduleSchema,
  bulkBlogActionSchema,
} from "./blog.validation";
import {
  listBlogsAdminHandler,
  getBlogAdminHandler,
  createBlogHandler,
  updateBlogHandler,
  setBlogStatusHandler,
  publishBlogHandler,
  unpublishBlogHandler,
  archiveBlogHandler,
  scheduleBlogHandler,
  duplicateBlogHandler,
  deleteBlogHandler,
  bulkBlogActionHandler,
} from "./blog.controller";

// Admin blog management. Addressed by Mongo _id (the admin already has the id
// from the list response) — public reads use the slug instead. Mounted at
// /admin/blogs behind requireAuth + requireRole("admin"), same as every other
// /admin/* CRUD router.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listBlogsAdminHandler);
router.post("/", validateBody(createBlogSchema), createBlogHandler);
router.post("/bulk", validateBody(bulkBlogActionSchema), bulkBlogActionHandler);
router.get("/:id", getBlogAdminHandler);
router.patch("/:id", validateBody(updateBlogSchema), updateBlogHandler);
router.delete("/:id", deleteBlogHandler);
router.post("/:id/status", validateBody(blogStatusSchema), setBlogStatusHandler);
router.post("/:id/publish", publishBlogHandler);
router.post("/:id/unpublish", unpublishBlogHandler);
router.post("/:id/archive", archiveBlogHandler);
router.post("/:id/schedule", validateBody(blogScheduleSchema), scheduleBlogHandler);
router.post("/:id/duplicate", duplicateBlogHandler);

export default router;
