import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { createProductSchema, updateProductSchema } from "./product.validation";
import {
  createPackSchema,
  updatePackSchema,
  updatePackConfigSchema,
  updateInventoryTrackingSchema,
  updateRelatedComboSchema,
} from "./pack.validation";
import {
  createProductHandler,
  getProductListHandler,
  getProductDetailHandler,
  updateProductHandler,
  deleteProductHandler,
  duplicateProductHandler,
} from "./product.controller";
import {
  listPacksHandler,
  createPackHandler,
  updatePackHandler,
  deletePackHandler,
  getPackConfigHandler,
  updatePackConfigHandler,
  getInventoryTrackingHandler,
  updateInventoryTrackingHandler,
  getRelatedComboHandler,
  updateRelatedComboHandler,
} from "./pack.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.post("/", validateBody(createProductSchema), createProductHandler);
router.get("/", getProductListHandler);
router.get("/:id", getProductDetailHandler);
router.patch("/:id", validateBody(updateProductSchema), updateProductHandler);
router.delete("/:id", deleteProductHandler);
router.post("/:id/duplicate", duplicateProductHandler);

// Pack / Combo Configuration (spec §17) — a sub-resource of the product,
// stored embedded on Product.packConfig, not a separate collection.
router.get("/:id/pack-config", getPackConfigHandler);
router.patch("/:id/pack-config", validateBody(updatePackConfigSchema), updatePackConfigHandler);
router.get("/:id/packs", listPacksHandler);
router.post("/:id/packs", validateBody(createPackSchema), createPackHandler);
router.put("/:id/packs/:packId", validateBody(updatePackSchema), updatePackHandler);
router.delete("/:id/packs/:packId", deletePackHandler);

// Admin-Configured Inventory Tracking — governs what a PLAIN purchase of
// this product deducts (a specific pack's own override lives on the pack
// itself, via useComponentInventory/inventoryComponents above).
router.get("/:id/inventory-tracking", getInventoryTrackingHandler);
router.patch("/:id/inventory-tracking", validateBody(updateInventoryTrackingSchema), updateInventoryTrackingHandler);

// Related Combo/Bundle Suggestion — offers a bundle instead of (or before)
// a plain purchase of this product on the storefront PDP (relatedCombo.service.ts).
router.get("/:id/related-combo", getRelatedComboHandler);
router.patch("/:id/related-combo", validateBody(updateRelatedComboSchema), updateRelatedComboHandler);

export default router;
