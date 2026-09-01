import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createBlogCategorySchema, updateBlogCategorySchema } from "./blogCategory.validation";
import {
  listBlogCategoriesAdminHandler,
  listBlogCategoryOptionsHandler,
  getBlogCategoryAdminHandler,
  createBlogCategoryHandler,
  updateBlogCategoryHandler,
  deleteBlogCategoryHandler,
} from "./blogCategory.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listBlogCategoriesAdminHandler);
router.get("/options", listBlogCategoryOptionsHandler);
router.post("/", validateBody(createBlogCategorySchema), createBlogCategoryHandler);
router.get("/:id", getBlogCategoryAdminHandler);
router.patch("/:id", validateBody(updateBlogCategorySchema), updateBlogCategoryHandler);
router.delete("/:id", deleteBlogCategoryHandler);

export default router;
