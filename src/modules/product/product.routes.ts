import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createProductSchema, updateProductSchema } from "./product.validation";
import {
  createProductHandler,
  getProductListHandler,
  getProductDetailHandler,
  updateProductHandler,
  deleteProductHandler,
  duplicateProductHandler,
} from "./product.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.post("/", validateBody(createProductSchema), createProductHandler);
router.get("/", getProductListHandler);
router.get("/:id", getProductDetailHandler);
router.patch("/:id", validateBody(updateProductSchema), updateProductHandler);
router.delete("/:id", deleteProductHandler);
router.post("/:id/duplicate", duplicateProductHandler);

export default router;
