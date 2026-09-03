import { z } from "zod";

// Rupee amount: non-negative and capped at a sane ceiling so a fat-fingered
// "4999999" can't silently switch free shipping off forever. Whole-rupee is
// not enforced — a ₹499.50 threshold is harmless — but the admin form only
// offers integer inputs.
const amount = z
  .number()
  .min(0, "Must be 0 or greater")
  .max(100000, "That value looks too high");

// Both fields optional so the PATCH can carry a single changed value, but at
// least one must be present. Anything not listed here (key, updatedBy,
// timestamps) is stripped — the mass-assignment guard every *.validation.ts
// in this codebase relies on.
export const updateStoreSettingsSchema = z
  .object({
    freeShippingThreshold: amount.optional(),
    flatShippingFee: amount.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateStoreSettingsInput = z.infer<typeof updateStoreSettingsSchema>;
