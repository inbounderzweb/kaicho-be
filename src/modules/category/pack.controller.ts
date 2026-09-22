import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import {
  listCategoryPacks,
  createCategoryPack,
  updateCategoryPack,
  deleteCategoryPack,
  getCategoryPackConfigSettings,
  updateCategoryPackConfigSettings,
} from "./pack.service";
import type {
  CreatePackInput,
  UpdatePackInput,
  UpdateCategoryPackConfigInput,
} from "../product/pack.validation";

export const listCategoryPacksHandler = asyncHandler(async (req: Request, res: Response) => {
  const packs = await listCategoryPacks(String(req.params.id));
  res.status(200).json({ success: true, data: { packs } });
});

export const createCategoryPackHandler = asyncHandler(async (req: Request, res: Response) => {
  const pack = await createCategoryPack(String(req.params.id), req.body as CreatePackInput);
  res.status(201).json({ success: true, message: "Pack created", data: { pack } });
});

export const updateCategoryPackHandler = asyncHandler(async (req: Request, res: Response) => {
  const pack = await updateCategoryPack(
    String(req.params.id),
    String(req.params.packId),
    req.body as UpdatePackInput
  );
  res.status(200).json({ success: true, message: "Pack updated", data: { pack } });
});

export const deleteCategoryPackHandler = asyncHandler(async (req: Request, res: Response) => {
  await deleteCategoryPack(String(req.params.id), String(req.params.packId));
  res.status(200).json({ success: true, message: "Pack deleted", data: null });
});

export const getCategoryPackConfigHandler = asyncHandler(async (req: Request, res: Response) => {
  const packConfig = await getCategoryPackConfigSettings(String(req.params.id));
  res.status(200).json({ success: true, data: { packConfig } });
});

export const updateCategoryPackConfigHandler = asyncHandler(async (req: Request, res: Response) => {
  const packConfig = await updateCategoryPackConfigSettings(
    String(req.params.id),
    req.body as UpdateCategoryPackConfigInput
  );
  res.status(200).json({ success: true, message: "Pack configuration updated", data: { packConfig } });
});
