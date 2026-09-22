import { z } from "zod";
import { cartItemSchema } from "./checkout.validation";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { recommendSmartSelection, validateSmartSelection } from "./smartRecommendation.service";
import { Router } from "express";
import { validateBody } from "../../common/middleware";
import { validatePackSchema, applyPackSchema } from "./cartPack.validation";
import { validatePackHandler, applyPackHandler } from "./cartPack.controller";

// Public, unauthenticated — same reasoning as the product catalog routes:
// this app lets anonymous shoppers add to cart before logging in, so a pack
// recommendation must be computable pre-login too (decision #6). Neither
// route reserves stock or touches an order — see cartPack.service.ts.
const router = Router();

router.post("/validate-pack", validateBody(validatePackSchema), validatePackHandler);
router.post("/apply-pack", validateBody(applyPackSchema), applyPackHandler);

const smartSchema = z.object({ selection: cartItemSchema, cart: z.array(cartItemSchema).max(50).default([]) });
router.post("/recommend", validateBody(smartSchema), asyncHandler(async (req, res) => {
  const { selection, cart } = smartSchema.parse(req.body);
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: await recommendSmartSelection(selection.productId, selection.quantity, cart) });
}));
router.post("/validate-selection", validateBody(smartSchema), asyncHandler(async (req, res) => {
  const { selection, cart } = smartSchema.parse(req.body);
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: await validateSmartSelection(selection, cart) });
}));
export default router;
