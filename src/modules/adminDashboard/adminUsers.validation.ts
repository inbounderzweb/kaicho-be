import { z } from "zod";
import { ROLES } from "../../common/constants/roles";

// Explicit allowlist — this is the mass-assignment guard. Zod strips any
// key not listed here by default, so a body like {"tokenVersion": 0,
// "isActive": true} only ever lets isActive through to the service layer.
export const updateUserSchema = z
  .object({
    firstName: z.string().trim().max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    email: z.string().trim().email("Please enter a valid email").max(160).optional(),
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateUserBody = z.infer<typeof updateUserSchema>;
