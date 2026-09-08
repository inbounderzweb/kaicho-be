import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  couponCreateSchema,
  couponUpdateSchema,
  couponStatusSchema,
} from "./adminCoupon.validation";
import {
  listCouponsHandler,
  getCouponHandler,
  createCouponHandler,
  updateCouponHandler,
  setCouponStatusHandler,
  listCouponUsagesHandler,
} from "./adminCoupon.controller";

// Admin coupon management. Same guard as every other /admin/* router
// (requireAuth + requireRole("admin")) — no bespoke authorization.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listCouponsHandler);
router.post("/", validateBody(couponCreateSchema), createCouponHandler);
router.get("/:id", getCouponHandler);
router.patch("/:id", validateBody(couponUpdateSchema), updateCouponHandler);
router.post("/:id/status", validateBody(couponStatusSchema), setCouponStatusHandler);
router.get("/:id/usages", listCouponUsagesHandler);

export default router;
