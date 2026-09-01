import { z } from "zod";
import { INQUIRY_STATUSES } from "../../database/models";
import { isValidIndianMobile } from "../../common/utils/phone";

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");

const name = z.string().trim().min(1, "Name is required").max(120, "Name is too long");
// The Mongoose schema lowercases `email` on write; this just validates shape.
const email = z.string().trim().email("Enter a valid email").max(160);
// Accepts the usual human formatting (spaces, dashes, +91 / 0 prefix) but the
// digit core must be a valid 10-digit Indian mobile. Service normalises to
// "+91XXXXXXXXXX" before storing.
const phone = z
  .string()
  .trim()
  .max(20)
  .refine((v) => isValidIndianMobile(v), "Enter a valid 10-digit mobile number");
const message = (max: number) => z.string().trim().max(max, "Message is too long");

export const submitBulkOrderSchema = z.object({
  name,
  email,
  phone,
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be greater than 0")
    .max(10_000_000, "Quantity is unreasonably large"),
  purpose: z.string().trim().min(1, "Purpose is required").max(200, "Purpose is too long"),
  message: message(5000).optional().or(z.literal("")),
});

export const submitContactSchema = z.object({
  name,
  email,
  phone: phone.optional().or(z.literal("")),
  message: message(5000).min(1, "Message is required"),
});

// Admin edit — every field optional, but at least one must be present.
export const updateInquirySchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    phone: z.string().trim().max(20).optional().or(z.literal("")),
    quantity: z.coerce.number().int().positive().max(10_000_000).optional(),
    purpose: z.string().trim().max(200).optional().or(z.literal("")),
    message: message(5000).optional().or(z.literal("")),
    status: z.enum(INQUIRY_STATUSES).optional(),
    assignedTo: objectId.nullable().optional().or(z.literal("")),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export const changeStatusSchema = z.object({
  status: z.enum(INQUIRY_STATUSES),
});

export const assignInquirySchema = z.object({
  // null / "" -> unassign
  assignedTo: objectId.nullable().or(z.literal("")),
});

export const addNoteSchema = z.object({
  note: z.string().trim().min(1, "Note cannot be empty").max(2000, "Note is too long"),
});

export type SubmitBulkOrderInput = z.infer<typeof submitBulkOrderSchema>;
export type SubmitContactInput = z.infer<typeof submitContactSchema>;
export type UpdateInquiryInput = z.infer<typeof updateInquirySchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type AssignInquiryInput = z.infer<typeof assignInquirySchema>;
export type AddNoteInput = z.infer<typeof addNoteSchema>;
