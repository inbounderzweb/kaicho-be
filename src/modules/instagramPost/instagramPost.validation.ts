import { z } from "zod";
import { INSTAGRAM_POST_STATUSES } from "../../database/models";
import {
  parseInstagramUrl,
  MAX_INSTAGRAM_URL_LENGTH,
  INSTAGRAM_URL_ERROR_MESSAGES,
} from "./instagramUrl";

// The URL field defers entirely to parseInstagramUrl (the single source of
// truth). Zod only enforces shape/length here so an over-long string is
// rejected before we bother constructing a URL from it.
const urlField = z
  .string()
  .trim()
  .min(1, INSTAGRAM_URL_ERROR_MESSAGES.EMPTY)
  .max(MAX_INSTAGRAM_URL_LENGTH, INSTAGRAM_URL_ERROR_MESSAGES.TOO_LONG)
  .superRefine((value, ctx) => {
    const result = parseInstagramUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: INSTAGRAM_URL_ERROR_MESSAGES[result.error] });
    }
  });

const displayOrderField = z
  .number({ message: "Display order must be a number" })
  .int("Display order must be a whole number")
  .min(0, "Display order cannot be negative")
  .max(100_000, "Display order is unreasonably large");

// ARCHIVED is reached via the status endpoint / delete, never set directly on
// create or a field edit — keeps "how does a post get archived" in one place.
const editableStatus = z.enum(["ACTIVE", "INACTIVE"]);

export const createInstagramPostSchema = z.object({
  url: urlField,
  displayOrder: displayOrderField.optional(),
  status: editableStatus.optional(),
});

export const updateInstagramPostSchema = z
  .object({
    url: urlField.optional(),
    displayOrder: displayOrderField.optional(),
    status: editableStatus.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

export const updateInstagramPostStatusSchema = z.object({
  status: z.enum(INSTAGRAM_POST_STATUSES),
});

export type CreateInstagramPostInput = z.infer<typeof createInstagramPostSchema>;
export type UpdateInstagramPostInput = z.infer<typeof updateInstagramPostSchema>;
export type UpdateInstagramPostStatusInput = z.infer<typeof updateInstagramPostStatusSchema>;
