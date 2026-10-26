import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  offerCreateSchema,
  offerUpdateSchema,
  offerStatusSchema,
  offerSimulateSchema,
} from "./adminOffer.validation";
import {
  listOffersHandler,
  getOfferHandler,
  createOfferHandler,
  updateOfferHandler,
  setOfferStatusHandler,
  listOfferUsagesHandler,
  simulateOfferHandler,
  deleteOfferHandler,
} from "./adminOffer.controller";

// Admin offer management. Same guard as every other /admin/* router.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listOffersHandler);
router.post("/", validateBody(offerCreateSchema), createOfferHandler);
router.get("/:id", getOfferHandler);
router.patch("/:id", validateBody(offerUpdateSchema), updateOfferHandler);
router.delete("/:id", deleteOfferHandler);
router.post("/:id/status", validateBody(offerStatusSchema), setOfferStatusHandler);
router.post("/:id/simulate", validateBody(offerSimulateSchema), simulateOfferHandler);
router.get("/:id/usages", listOfferUsagesHandler);

export default router;
