import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import {
  listPacks,
  createPack,
  updatePack,
  deletePack,
  getPackConfigSettings,
  updatePackConfigSettings,
} from "./pack.service";
import {
  getInventoryTrackingSettings,
  updateInventoryTrackingSettings,
  getRelatedComboSettings,
  updateRelatedComboSettings,
} from "./product.service";
import type {
  CreatePackInput,
  UpdatePackInput,
  UpdatePackConfigInput,
  UpdateInventoryTrackingInput,
  UpdateRelatedComboInput,
} from "./pack.validation";

export const listPacksHandler = asyncHandler(async (req: Request, res: Response) => {
  const packs = await listPacks(String(req.params.id));
  res.status(200).json({ success: true, data: { packs } });
});

export const createPackHandler = asyncHandler(async (req: Request, res: Response) => {
  const pack = await createPack(String(req.params.id), req.body as CreatePackInput);
  res.status(201).json({ success: true, message: "Pack created", data: { pack } });
});

export const updatePackHandler = asyncHandler(async (req: Request, res: Response) => {
  const pack = await updatePack(String(req.params.id), String(req.params.packId), req.body as UpdatePackInput);
  res.status(200).json({ success: true, message: "Pack updated", data: { pack } });
});

export const deletePackHandler = asyncHandler(async (req: Request, res: Response) => {
  await deletePack(String(req.params.id), String(req.params.packId));
  res.status(200).json({ success: true, message: "Pack deleted", data: null });
});

export const getPackConfigHandler = asyncHandler(async (req: Request, res: Response) => {
  const packConfig = await getPackConfigSettings(String(req.params.id));
  res.status(200).json({ success: true, data: { packConfig } });
});

export const updatePackConfigHandler = asyncHandler(async (req: Request, res: Response) => {
  const packConfig = await updatePackConfigSettings(String(req.params.id), req.body as UpdatePackConfigInput);
  res.status(200).json({ success: true, message: "Pack configuration updated", data: { packConfig } });
});

export const getInventoryTrackingHandler = asyncHandler(async (req: Request, res: Response) => {
  const inventoryTracking = await getInventoryTrackingSettings(String(req.params.id));
  res.status(200).json({ success: true, data: { inventoryTracking } });
});

export const updateInventoryTrackingHandler = asyncHandler(async (req: Request, res: Response) => {
  const inventoryTracking = await updateInventoryTrackingSettings(
    String(req.params.id),
    req.body as UpdateInventoryTrackingInput
  );
  res.status(200).json({ success: true, message: "Inventory tracking updated", data: { inventoryTracking } });
});

export const getRelatedComboHandler = asyncHandler(async (req: Request, res: Response) => {
  const relatedCombo = await getRelatedComboSettings(String(req.params.id));
  res.status(200).json({ success: true, data: { relatedCombo } });
});

export const updateRelatedComboHandler = asyncHandler(async (req: Request, res: Response) => {
  const relatedCombo = await updateRelatedComboSettings(String(req.params.id), req.body as UpdateRelatedComboInput);
  res.status(200).json({ success: true, message: "Related combo updated", data: { relatedCombo } });
});
