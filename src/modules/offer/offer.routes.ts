import { Router } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { validateBody, offerEvaluateLimiter } from "../../common/middleware";
import { previewCheckout } from "../checkout/checkout.service";
import { evaluateOfferSchema } from "./offer.validation";
import { listPublicActiveOffers } from "./offer.service";

// Public, read-only: which offers are live right now. Display data only —
// the cart and checkout never trust it (they re-evaluate server-side).
const router = Router();

router.get(
  "/active",
  asyncHandler(async (_req, res) => {
    const offers = await listPublicActiveOffers();
    // Short cache: offer windows are minutes-granular, and the storefront
    // badge being up to a minute stale is harmless (checkout is authoritative).
    res.set("Cache-Control", "public, max-age=30");
    res.status(200).json({ success: true, data: { offers } });
  })
);

// Guest-safe cart pricing: the same server-side evaluation checkout preview
// uses (DB prices, live stock, live offers) minus anything account-specific —
// no coupon, no per-user usage limits. This is what lets the CART page show
// FREE units and the real discount before the customer has logged in.
// Checkout re-evaluates everything again, authoritatively.
router.post(
  "/evaluate",
  offerEvaluateLimiter,
  validateBody(evaluateOfferSchema),
  asyncHandler(async (req, res) => {
    const data = await previewCheckout(null, req.body);
    res.status(200).json({ success: true, data });
  })
);

export default router;
