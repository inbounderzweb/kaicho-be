import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { getPublicBrandList } from "./brand.service";

export const getPublicBrandListHandler = asyncHandler(async (_req: Request, res: Response) => {
  const brands = await getPublicBrandList();
  res.status(200).json({ success: true, data: { brands } });
});
