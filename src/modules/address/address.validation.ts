import { z } from "zod";

// Indian 6-digit PIN codes, no leading zero (matching the customer base this
// store ships to — DEFAULT_COUNTRY_CODE is +91 and there is no
// multi-country address support anywhere in this app).
const pincodeField = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Enter a valid 6-digit pincode");

// 10-digit Indian mobile, stored without the +91 prefix. Same digit-strip +
// pattern as auth.validation's phoneField, kept local so the two can't drift.
const receiverPhoneField = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ""))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"));

const receiverNameField = z
  .string()
  .trim()
  .min(2, "Receiver name is too short")
  .max(80, "Receiver name is too long");

const houseNoField = z
  .string()
  .trim()
  .min(1, "House / flat number is required")
  .max(60, "House / flat number is too long");

const buildingField = z.string().trim().max(80, "Building / block is too long").optional();

const areaField = z
  .string()
  .trim()
  .min(3, "Street / area is too short")
  .max(120, "Street / area is too long");

const landmarkField = z.string().trim().max(120, "Landmark is too long").optional();

// `line1` / `line2` are NOT accepted from the client any more — the service
// derives them from the structured fields below.
export const createAddressSchema = z.object({
  label: z.string().trim().max(50, "Label is too long").optional(),
  receiverName: receiverNameField,
  receiverPhone: receiverPhoneField,
  houseNo: houseNoField,
  building: buildingField,
  area: areaField,
  landmark: landmarkField,
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
    receiverName: receiverNameField.optional(),
    receiverPhone: receiverPhoneField.optional(),
    houseNo: houseNoField.optional(),
    building: buildingField,
    area: areaField.optional(),
    landmark: landmarkField,
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
