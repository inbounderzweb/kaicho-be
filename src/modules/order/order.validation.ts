import { z } from "zod";
import { ORDER_STATUSES } from "../../database/models";

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
