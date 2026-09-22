import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { getPackRecommendation, applyPackSelection } from "./cartPack.service";
import type { ValidatePackInput, ApplyPackInput } from "./cartPack.validation";

export const validatePackHandler = asyncHandler(async (req: Request, res: Response) => {
  const recommendation = await getPackRecommendation(req.body as ValidatePackInput);
  res.status(200).json({ success: true, data: recommendation });
});

export const applyPackHandler = asyncHandler(async (req: Request, res: Response) => {
  const applied = await applyPackSelection(req.body as ApplyPackInput);
  res.status(200).json({ success: true, data: applied });
});
