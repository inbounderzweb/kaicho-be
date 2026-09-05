import { z } from "zod";

// Reverse geocoding takes coordinates in the BODY (not the query string) so a
// user's precise position never lands in an access log or a shareable URL.
export const reverseSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, "Type at least 2 characters").max(120),
});

export const serviceabilityQuerySchema = z
  .object({
    pincode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter a valid 6-digit PIN code")
      .optional(),
    country: z.string().trim().max(80).optional(),
  })
  .refine((v) => v.pincode || v.country, {
    message: "Provide a pincode or country",
  });

export type ReverseInput = z.infer<typeof reverseSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ServiceabilityQuery = z.infer<typeof serviceabilityQuerySchema>;
