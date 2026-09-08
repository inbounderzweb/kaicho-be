import { z } from "zod";
import { cartItemsField } from "../checkout/checkout.validation";

// The client sends only a code and its cart lines — never a discount, a
// subtotal or a total. The cart lines reuse the exact same untrusted-input
// shape checkout uses (see checkout.validation.ts); everything billable is
// re-read from the DB server-side.
export const validateCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Enter a coupon code")
    .max(40, "Coupon code is too long"),
  items: cartItemsField,
});

export type ValidateCouponInput = z.infer<typeof validateCouponSchema>;
