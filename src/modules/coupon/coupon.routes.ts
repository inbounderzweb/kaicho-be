import { Router } from "express";
import { requireAuth, validateBody, couponValidateLimiter } from "../../common/middleware";
import { validateCouponSchema } from "./coupon.validation";
import { validateCouponHandler } from "./coupon.controller";

// Customer-facing coupon surface. Admin coupon management (CRUD, usage
// history) will mount separately under /api/admin/coupons.
const router = Router();

router.use(requireAuth);

// couponValidateLimiter runs after requireAuth so it keys on req.userId, not
// a shared NAT'd IP.
router.post("/validate", couponValidateLimiter, validateBody(validateCouponSchema), validateCouponHandler);

export default router;
