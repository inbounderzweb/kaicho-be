import { z } from "zod";
import { MAX_COMBINATION_QUANTITY } from "../product/packCombination.service";

const objectIdField = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const validatePackSchema = z.object({
  productId: objectIdField,
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be at least 1")
    .max(MAX_COMBINATION_QUANTITY, "Quantity is too large"),
});

export type ValidatePackInput = z.infer<typeof validatePackSchema>;

export const applyPackSchema = z.object({
  productId: objectIdField,
  packSelection: z
    .array(
      z.object({
        packId: objectIdField,
        count: z.number().int("Pack count must be a whole number").positive("Pack count must be at least 1"),
      })
    )
    .min(1, "Select at least one pack")
    .max(20, "Too many pack lines"),
});

export type ApplyPackInput = z.infer<typeof applyPackSchema>;
