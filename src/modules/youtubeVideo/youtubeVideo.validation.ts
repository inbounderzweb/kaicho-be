import { z } from "zod";
import { YOUTUBE_VIDEO_STATUSES } from "../../database/models";
import {
  parseYouTubeUrl,
  MAX_YOUTUBE_URL_LENGTH,
  YOUTUBE_URL_ERROR_MESSAGES,
} from "./youtubeUrl";

const urlField = z
  .string()
  .trim()
  .min(1, YOUTUBE_URL_ERROR_MESSAGES.EMPTY)
  .max(MAX_YOUTUBE_URL_LENGTH, YOUTUBE_URL_ERROR_MESSAGES.TOO_LONG)
  .superRefine((value, ctx) => {
    const result = parseYouTubeUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: YOUTUBE_URL_ERROR_MESSAGES[result.error] });
    }
  });

const displayOrderField = z
  .number({ message: "Display order must be a number" })
  .int("Display order must be a whole number")
  .min(0, "Display order cannot be negative")
  .max(100_000, "Display order is unreasonably large");

const editableStatus = z.enum(["ACTIVE", "INACTIVE"]);

export const createYouTubeVideoSchema = z.object({
  url: urlField,
  displayOrder: displayOrderField.optional(),
  status: editableStatus.optional(),
});

export const updateYouTubeVideoSchema = z
  .object({
    url: urlField.optional(),
    displayOrder: displayOrderField.optional(),
    status: editableStatus.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

export const updateYouTubeVideoStatusSchema = z.object({
  status: z.enum(YOUTUBE_VIDEO_STATUSES),
});

export type CreateYouTubeVideoInput = z.infer<typeof createYouTubeVideoSchema>;
export type UpdateYouTubeVideoInput = z.infer<typeof updateYouTubeVideoSchema>;
export type UpdateYouTubeVideoStatusInput = z.infer<typeof updateYouTubeVideoStatusSchema>;
