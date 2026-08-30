import { Router } from "express";
import { requireAuth, validateBody, checkoutLimiter } from "../../common/middleware";
import { checkoutPreviewSchema, createCheckoutSchema } from "./checkout.validation";
import { previewCheckoutHandler, createCheckoutHandler } from "./checkout.controller";

const router = Router();

router.use(requireAuth);

// Preview is deliberately unthrottled beyond auth: it's a pure read, and the
// checkout page calls it on load and again whenever the cart changes, so
// rate-limiting it would break normal use.
router.post("/preview", validateBody(checkoutPreviewSchema), previewCheckoutHandler);

// checkoutLimiter runs after requireAuth so its keyGenerator can key on
// req.userId rather than a shared NAT'd IP.
router.post("/", checkoutLimiter, validateBody(createCheckoutSchema), createCheckoutHandler);

export default router;
