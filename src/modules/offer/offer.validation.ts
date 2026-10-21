import { z } from "zod";
import { cartItemsField, freeSelectionsField } from "../checkout/checkout.validation";

// Same untrusted-cart shape checkout uses: product ids + quantities (+ the
// customer's free-item picks). No price, discount or flag is accepted.
export const evaluateOfferSchema = z.object({
  items: cartItemsField,
  freeSelections: freeSelectionsField,
});

export type EvaluateOfferInput = z.infer<typeof evaluateOfferSchema>;
