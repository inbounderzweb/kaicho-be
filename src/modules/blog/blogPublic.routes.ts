import { Router } from "express";
import {
  listBlogsPublicHandler,
  getBlogPublicHandler,
  getRelatedBlogsPublicHandler,
} from "./blog.controller";
import {
  listBlogCategoriesPublicHandler,
  getBlogCategoryPublicHandler,
} from "./blogCategory.controller";

// Unauthenticated customer-facing blog surface. Deliberately separate from the
// /admin/blogs router: slug-addressed, a smaller published-only DTO, and no
// draft/scheduled/archived content ever leaves here (see blog.service.ts's
// publicMatch()). Same split as productPublic.routes.ts vs product.routes.ts.
const router = Router();

// Static segments before the "/:slug" catch so they are not shadowed.
router.get("/", listBlogsPublicHandler);
router.get("/categories", listBlogCategoriesPublicHandler);
router.get("/categories/:slug", getBlogCategoryPublicHandler);
router.get("/:slug/related", getRelatedBlogsPublicHandler);
router.get("/:slug", getBlogPublicHandler);

export default router;
