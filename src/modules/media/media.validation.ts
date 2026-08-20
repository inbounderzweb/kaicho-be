import { z } from "zod";
import { MEDIA_ENTITY_TYPES, MEDIA_STATUSES, MEDIA_TYPES } from "../../database/models";

// Explicit allowlist — the mass-assignment guard. storageKey/storageProvider/
// uploadedBy are never listed here, so they can never reach the update path
// regardless of what the client sends.
export const updateMediaSchema = z
  .object({
    altText: z.string().trim().max(300).optional(),
    isPrimary: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateMediaBody = z.infer<typeof updateMediaSchema>;

export const mediaListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(MEDIA_STATUSES).optional(),
  mediaType: z.enum(MEDIA_TYPES).optional(),
  mimeType: z.string().trim().max(100).optional(),
  entityType: z.enum(MEDIA_ENTITY_TYPES).optional(),
  sort: z.enum(["createdAt", "size", "originalName"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;
