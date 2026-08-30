import { z } from "zod";
import { ORDER_PAYMENT_METHODS } from "../../database/models";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// The cart lives client-side (zustand + localStorage), so its lines arrive in
// the request body — and are therefore entirely untrusted. Note what is NOT
// accepted here: no price, no name, no image. Everything billable is re-read
// from the Product collection server-side, which is what makes a tampered
// localStorage cart harmless.
const cartItemSchema = z.object({
  productId: objectIdField,
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(100, "Quantity is too large"),
});

const cartItemsField = z
  .array(cartItemSchema)
  .min(1, "Your cart is empty")
  .max(50, "Too many items in one order")
  .refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
    "The same product appears more than once — merge it into a single line"
  );

export const checkoutPreviewSchema = z.object({
  items: cartItemsField,
});

export const createCheckoutSchema = z.object({
  items: cartItemsField,
  addressId: objectIdField,
  paymentMethod: z.enum(ORDER_PAYMENT_METHODS),
});

export type CheckoutPreviewInput = z.infer<typeof checkoutPreviewSchema>;
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
