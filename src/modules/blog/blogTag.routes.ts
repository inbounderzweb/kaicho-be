import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createBlogTagSchema, updateBlogTagSchema } from "./blogTag.validation";
import {
  listBlogTagsHandler,
  createBlogTagHandler,
  updateBlogTagHandler,
  deleteBlogTagHandler,
} from "./blogTag.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listBlogTagsHandler);
router.post("/", validateBody(createBlogTagSchema), createBlogTagHandler);
router.patch("/:id", validateBody(updateBlogTagSchema), updateBlogTagHandler);
router.delete("/:id", deleteBlogTagHandler);

export default router;
