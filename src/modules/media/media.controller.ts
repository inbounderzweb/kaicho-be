import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  uploadFiles,
  getMediaList,
  getMediaById,
  updateMediaById,
  deleteMediaById,
} from "./media.service";
import type { UpdateMediaBody } from "./media.validation";

export const uploadMediaHandler = asyncHandler(async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    throw new AppError("No files were provided", 400);
  }

  const { succeeded, errors } = await uploadFiles(files, req.userId!);

  if (succeeded.length === 0) {
    res.status(400).json({ success: false, message: "All files were rejected", errors });
    return;
  }

  res.status(201).json({ success: true, data: succeeded, errors });
});

export const getMediaListHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await getMediaList({
    page,
    pageSize,
    search: req.query.search,
    status: req.query.status,
    mediaType: req.query.mediaType,
    mimeType: req.query.mimeType,
    entityType: req.query.entityType,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getMediaDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const media = await getMediaById(String(req.params.id));
  if (!media) {
    throw new AppError("Media not found", 404);
  }
  res.status(200).json({ success: true, data: { media } });
});

export const updateMediaHandler = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateMediaBody;
  const media = await updateMediaById(String(req.params.id), patch);
  if (!media) {
    throw new AppError("Media not found", 404);
  }
  res.status(200).json({ success: true, message: "Media updated", data: { media } });
});

export const deleteMediaHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await deleteMediaById(String(req.params.id), req.userId!);
  if (result === null) {
    throw new AppError("Media not found", 404);
  }
  res.status(200).json({ success: true, message: "Media deleted" });
});
