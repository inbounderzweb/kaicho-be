import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import {
  listPopups,
  getPopupById,
  createPopup,
  updatePopup,
  setPopupStatus,
  archivePopup,
  listLivePopups,
  recordPopupEvent,
} from "./popup.service";
import type {
  CreatePopupInput,
  UpdatePopupInput,
  PopupEventInput,
} from "./popup.validation";
import type { PopupStatus } from "../../database/models";

export const listPopupsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listPopups({ page, pageSize, search: req.query.search, status: req.query.status });
  res.status(200).json({ success: true, data });
});

export const getPopupHandler = asyncHandler(async (req: Request, res: Response) => {
  const popup = await getPopupById(String(req.params.id));
  res.status(200).json({ success: true, data: { popup } });
});

export const createPopupHandler = asyncHandler(async (req: Request, res: Response) => {
  const popup = await createPopup(req.body as CreatePopupInput, req.userId);
  res.status(201).json({ success: true, message: "Popup saved as draft", data: { popup } });
});

export const updatePopupHandler = asyncHandler(async (req: Request, res: Response) => {
  const popup = await updatePopup(String(req.params.id), req.body as UpdatePopupInput, req.userId);
  res.status(200).json({ success: true, message: "Popup updated", data: { popup } });
});

export const updatePopupStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as { status: PopupStatus };
  const popup = await setPopupStatus(String(req.params.id), status, req.userId);
  res.status(200).json({ success: true, message: `Popup ${status.toLowerCase()}`, data: { popup } });
});

export const deletePopupHandler = asyncHandler(async (req: Request, res: Response) => {
  await archivePopup(String(req.params.id), req.userId);
  res.status(200).json({ success: true, message: "Popup archived" });
});

// ---- Public ----

export const listLivePopupsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const popups = await listLivePopups();
  // Short, revalidated cache — NOT the long stale-while-revalidate publicCache
  // used for the catalog. Pausing / expiring a popup must stop it reaching
  // visitors within seconds, not minutes.
  res.set("Cache-Control", "public, max-age=15, must-revalidate");
  res.status(200).json({ success: true, data: { popups } });
});

export const recordPopupEventHandler = asyncHandler(async (req: Request, res: Response) => {
  await recordPopupEvent(String(req.params.id), req.body as PopupEventInput);
  // Same response whether counted or not — don't reveal popup state.
  res.status(204).end();
});
