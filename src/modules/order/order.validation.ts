import { z } from "zod";
import { ORDER_STATUSES, SHIPMENT_STATUSES } from "../../database/models";

export const cancelOrderSchema = z.object({
  reason: z.string().trim().max(500, "Reason is too long").optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(500, "Note is too long").optional(),
});

// Rupees, not paise — the API surface is rupee-denominated everywhere else
// (Order.pricing, Product.pricing), and the paise conversion happens once at
// the Razorpay boundary. Omitting the amount means a full refund.
export const refundOrderSchema = z.object({
  amount: z
    .number()
    .positive("Refund amount must be greater than 0")
    .max(10_000_000, "Refund amount is unreasonably large")
    .optional(),
});

export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type RefundOrderInput = z.infer<typeof refundOrderSchema>;

// ---- Shipment ----
// AWB / tracking numbers across Indian couriers are alphanumeric, sometimes
// hyphenated, and land in the 8–20 char range — the bounds here are
// deliberately loose (4–40) so a valid number is never rejected, while still
// catching an empty box or a pasted sentence.
const TRACKING_NUMBER_RE = /^[A-Za-z0-9-]{4,40}$/;

// One endpoint (PUT /admin/orders/:id/shipment) both creates and edits the
// shipment, so every field is optional here — the service layer requires
// `carrier` + `trackingNumber` on the *first* save. `z.coerce.date()` accepts
// the "YYYY-MM-DD" value the admin date inputs submit.
export const saveShipmentSchema = z
  .object({
    carrier: z.string().trim().min(2, "Courier name is too short").max(80).optional(),
    trackingNumber: z
      .string()
      .trim()
      .regex(TRACKING_NUMBER_RE, "Enter a valid tracking / AWB number")
      .optional(),
    shipmentId: z.string().trim().max(80).optional(),
    trackingUrl: z.string().trim().url("Enter a valid tracking URL").max(500).optional(),
    shippedAt: z.coerce.date().optional(),
    estimatedDeliveryAt: z.coerce.date().optional(),
    status: z.enum(SHIPMENT_STATUSES).optional(),
    notes: z.string().trim().max(500, "Note is too long").optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No shipment fields provided" })
  .refine(
    (d) => !(d.shippedAt && d.estimatedDeliveryAt) || d.estimatedDeliveryAt >= d.shippedAt,
    { message: "Expected delivery date cannot be before the shipping date", path: ["estimatedDeliveryAt"] }
  );

export const updateShipmentStatusSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  note: z.string().trim().max(500, "Note is too long").optional(),
});

export type SaveShipmentInput = z.infer<typeof saveShipmentSchema>;
export type UpdateShipmentStatusInput = z.infer<typeof updateShipmentStatusSchema>;
