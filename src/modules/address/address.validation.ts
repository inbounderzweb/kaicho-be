import { z } from "zod";

// Indian 6-digit PIN codes, no leading zero (matching the customer base this
// store ships to — DEFAULT_COUNTRY_CODE is +91 and there is no
// multi-country address support anywhere in this app).
const pincodeField = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Enter a valid 6-digit pincode");

export const createAddressSchema = z.object({
  label: z.string().trim().max(50, "Label is too long").optional(),
  line1: z.string().trim().min(3, "Address line 1 is too short").max(200, "Address line 1 is too long"),
  line2: z.string().trim().max(200, "Address line 2 is too long").optional(),
  city: z.string().trim().min(2, "City is too short").max(100, "City is too long"),
  state: z.string().trim().min(2, "State is too short").max(100, "State is too long"),
  pincode: pincodeField,
  isDefault: z.boolean().optional(),
});

// Every field optional, but the request must actually change something —
// an empty patch is a client bug, not a silent no-op.
export const updateAddressSchema = z
  .object({
    label: z.string().trim().max(50, "Label is too long").optional(),
    line1: z.string().trim().min(3, "Address line 1 is too short").max(200, "Address line 1 is too long").optional(),
    line2: z.string().trim().max(200, "Address line 2 is too long").optional(),
    city: z.string().trim().min(2, "City is too short").max(100, "City is too long").optional(),
    state: z.string().trim().min(2, "State is too short").max(100, "State is too long").optional(),
    pincode: pincodeField.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

export type CreateAddressInput = z.infer<typeof createAddressSchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;
