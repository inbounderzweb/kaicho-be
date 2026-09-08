import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { validateCouponForCart } from "../checkout/checkout.service";
import type { ValidateCouponInput } from "./coupon.validation";

// POST /api/coupons/validate — "can I use this code with this cart?"
// Returns the backend-computed discount + pricing, or an AppError (handled by
// the global errorHandler) explaining why not. Never consumes usage.
export const validateCouponHandler = asyncHandler(async (req: Request, res: Response) => {
  const { code, items } = req.body as ValidateCouponInput;
  const data = await validateCouponForCart(req.userId!, code, items);
  res.status(200).json({ success: true, data });
});
