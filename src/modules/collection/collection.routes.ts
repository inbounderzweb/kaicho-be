import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  createCollectionSchema,
  updateCollectionProductsSchema,
  updateCollectionSchema,
} from "./collection.validation";
import {
  createCollectionHandler,
  deleteCollectionHandler,
  getCollectionDetailHandler,
  getCollectionListHandler,
  updateCollectionHandler,
  updateCollectionProductsHandler,
  getHomepageCollectionsHandler,
} from "./collection.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));
router.post("/", validateBody(createCollectionSchema), createCollectionHandler);
router.get("/", getCollectionListHandler);
router.get("/:id", getCollectionDetailHandler);
router.patch("/:id", validateBody(updateCollectionSchema), updateCollectionHandler);
router.patch("/:id/products", validateBody(updateCollectionProductsSchema), updateCollectionProductsHandler);
router.delete("/:id", deleteCollectionHandler);

export default router;
