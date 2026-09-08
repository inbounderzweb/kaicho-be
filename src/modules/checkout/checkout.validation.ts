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

// Exported so the coupon module's /validate schema reuses the exact same
// untrusted-cart shape (see coupon.validation.ts).
export const cartItemsField = z
  .array(cartItemSchema)
  .min(1, "Your cart is empty")
  .max(50, "Too many items in one order")
  .refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
    "The same product appears more than once — merge it into a single line"
  );

// A coupon code is the only coupon input the client ever sends — never a
// discount amount or a total. Trimmed here; canonicalised (uppercased,
// spaces stripped) server-side in coupon.service.
const couponCodeField = z
  .string()
  .trim()
  .min(1, "Enter a coupon code")
  .max(40, "Coupon code is too long")
  .optional();

export const checkoutPreviewSchema = z.object({
  items: cartItemsField,
  couponCode: couponCodeField,
});

export const createCheckoutSchema = z.object({
  items: cartItemsField,
  addressId: objectIdField,
  paymentMethod: z.enum(ORDER_PAYMENT_METHODS),
  couponCode: couponCodeField,
});

export type CheckoutPreviewInput = z.infer<typeof checkoutPreviewSchema>;
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
