import { z } from "zod";
import { ORDER_PAYMENT_METHODS } from "../../database/models";
import { MAX_COMBINATION_QUANTITY } from "../product/packCombination.service";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// A line MAY carry the pack combination the customer confirmed (via
// /cart/validate-pack or /cart/apply-pack) — but this is only ever a hint.
// checkout.service.ts re-validates it against the product's live pack
// config and recomputes the price/quantity server-side; nothing here is
// trusted for money math (spec §7/§23).
const packSelectionLineSchema = z.object({
  packId: objectIdField,
  count: z.number().int("Pack count must be a whole number").positive("Pack count must be at least 1"),
});

// The cart lives client-side (zustand + localStorage), so its lines arrive in
// the request body — and are therefore entirely untrusted. Note what is NOT
// accepted here: no price, no name, no image. Everything billable is re-read
// from the Product collection server-side, which is what makes a tampered
// localStorage cart harmless.
export const cartItemSchema = z.object({
  productId: objectIdField,
  // For a plain UNIT line this is the requested quantity, as before. For a
  // PACK line, checkout.service.ts ignores it and recomputes the total base
  // units from `packSelection` itself — it's only required here for schema
  // simplicity, not trusted either way.
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(MAX_COMBINATION_QUANTITY, "Quantity is too large"),
  packSelection: z.array(packSelectionLineSchema).min(1).max(20).optional(),
});

// Two lines for the same product are only a "duplicate" (and thus rejected)
// when they resolve to the exact same selection — a plain unit line and a
// pack line for the same product must be able to coexist (spec §14), so the
// dedupe key includes the (sorted, canonicalised) pack selection, not just
// productId.
function lineKey(item: { productId: string; packSelection?: { packId: string; count: number }[] }): string {
  if (!item.packSelection || item.packSelection.length === 0) {
    return `${item.productId}:UNIT`;
  }
  const sorted = [...item.packSelection].sort((a, b) => a.packId.localeCompare(b.packId));
  return `${item.productId}:PACK:${sorted.map((p) => `${p.packId}x${p.count}`).join(",")}`;
}

// Exported so the coupon module's /validate schema reuses the exact same
// untrusted-cart shape (see coupon.validation.ts).
export const cartItemsField = z
  .array(cartItemSchema)
  .min(1, "Your cart is empty")
  .max(50, "Too many items in one order")
  .refine(
    (items) => new Set(items.map(lineKey)).size === items.length,
    "The same selection appears more than once — merge it into a single line"
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
