import { Router } from "express";
import {
  getPublicProductListHandler,
  getPublicProductDetailHandler,
  getRelatedProductsHandler,
} from "./productPublic.controller";

// Deliberately separate from product.routes.ts (the admin CRUD router,
// mounted at /admin/products behind requireAuth+requireRole("admin")) — this
// router is unauthenticated by design and returns a different, smaller DTO
// (see product.service.ts's "Public catalog" section). Same underlying
// Product model/service, different route surface and response shape — spec
// §3/§48/§49.
const router = Router();

router.get("/", getPublicProductListHandler);
router.get("/:slug/related", getRelatedProductsHandler);
router.get("/:slug", getPublicProductDetailHandler);

export default router;
