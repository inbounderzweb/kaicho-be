import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { getStoreSettings, updateStoreSettings } from "./settings.service";
import type { UpdateStoreSettingsInput } from "./settings.validation";

export const getStoreSettingsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getStoreSettings();
  res.status(200).json({ success: true, data: { settings } });
});

export const updateStoreSettingsHandler = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateStoreSettingsInput;
  const settings = await updateStoreSettings(patch, req.userId);
  res.status(200).json({ success: true, message: "Settings updated", data: { settings } });
});

// Public, unauthenticated — the storefront cart/checkout pages read the
// shipping policy from here. Same DTO as the admin GET; there is nothing
// admin-only in it yet, so it's returned verbatim.
export const getPublicStoreSettingsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getStoreSettings();
  res.status(200).json({ success: true, data: { settings } });
});
