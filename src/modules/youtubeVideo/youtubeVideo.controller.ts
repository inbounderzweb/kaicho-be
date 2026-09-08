import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import {
  listYouTubeVideos,
  getYouTubeVideoById,
  createYouTubeVideo,
  updateYouTubeVideo,
  setYouTubeVideoStatus,
  archiveYouTubeVideo,
} from "./youtubeVideo.service";
import type {
  CreateYouTubeVideoInput,
  UpdateYouTubeVideoInput,
  UpdateYouTubeVideoStatusInput,
} from "./youtubeVideo.validation";

export const listYouTubeVideosHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listYouTubeVideos({
    page,
    pageSize,
    search: req.query.search,
    status: req.query.status,
  });
  res.status(200).json({ success: true, data });
});

export const getYouTubeVideoHandler = asyncHandler(async (req: Request, res: Response) => {
  const video = await getYouTubeVideoById(String(req.params.id));
  res.status(200).json({ success: true, data: { video } });
});

export const createYouTubeVideoHandler = asyncHandler(async (req: Request, res: Response) => {
  const video = await createYouTubeVideo(req.body as CreateYouTubeVideoInput, req.userId);
  res.status(201).json({ success: true, message: "YouTube video added", data: { video } });
});

export const updateYouTubeVideoHandler = asyncHandler(async (req: Request, res: Response) => {
  const video = await updateYouTubeVideo(
    String(req.params.id),
    req.body as UpdateYouTubeVideoInput,
    req.userId
  );
  res.status(200).json({ success: true, message: "YouTube video updated", data: { video } });
});

export const updateYouTubeVideoStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as UpdateYouTubeVideoStatusInput;
  const video = await setYouTubeVideoStatus(String(req.params.id), status, req.userId);
  res.status(200).json({ success: true, message: `YouTube video ${status.toLowerCase()}`, data: { video } });
});

export const deleteYouTubeVideoHandler = asyncHandler(async (req: Request, res: Response) => {
  await archiveYouTubeVideo(String(req.params.id), req.userId);
  res.status(200).json({ success: true, message: "YouTube video archived" });
});
