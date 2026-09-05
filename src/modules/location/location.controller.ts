import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import {
  reverseGeocode,
  searchLocations,
  getLocationFromIp,
  checkServiceability,
} from "./location.service";
import { searchQuerySchema, serviceabilityQuerySchema } from "./location.validation";
import type { ReverseInput } from "./location.validation";

// POST — coordinates arrive in the body (see location.validation.ts). Nothing
// here logs them.
export const reverseHandler = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lng } = req.body as ReverseInput;
  const location = await reverseGeocode(lat, lng);
  res.status(200).json({ success: true, data: { location } });
});

export const searchHandler = asyncHandler(async (req: Request, res: Response) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues.map((i) => i.message).join(", "), 400);
  }
  const results = await searchLocations(parsed.data.q);
  res.status(200).json({ success: true, data: { results } });
});

// GET — reads req.ip only to build the upstream URL; the address is never
// echoed back to the client.
export const ipHandler = asyncHandler(async (req: Request, res: Response) => {
  const location = await getLocationFromIp(req.ip);
  res.status(200).json({ success: true, data: { location } });
});

export const serviceabilityHandler = asyncHandler(async (req: Request, res: Response) => {
  const parsed = serviceabilityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues.map((i) => i.message).join(", "), 400);
  }
  const result = checkServiceability(parsed.data);
  res.status(200).json({ success: true, data: { serviceability: result } });
});
