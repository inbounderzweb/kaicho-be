import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import {
  listInstagramPosts,
  getInstagramPostById,
  createInstagramPost,
  updateInstagramPost,
  setInstagramPostStatus,
  archiveInstagramPost,
} from "./instagramPost.service";
import type {
  CreateInstagramPostInput,
  UpdateInstagramPostInput,
  UpdateInstagramPostStatusInput,
} from "./instagramPost.validation";

// Thin controllers: pagination + body handoff + response envelope. All rules
// live in the service.

export const listInstagramPostsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listInstagramPosts({
    page,
    pageSize,
    search: req.query.search,
    status: req.query.status,
  });
  res.status(200).json({ success: true, data });
});

export const getInstagramPostHandler = asyncHandler(async (req: Request, res: Response) => {
  const post = await getInstagramPostById(String(req.params.id));
  res.status(200).json({ success: true, data: { post } });
});

export const createInstagramPostHandler = asyncHandler(async (req: Request, res: Response) => {
  const post = await createInstagramPost(req.body as CreateInstagramPostInput, req.userId);
  res.status(201).json({ success: true, message: "Instagram post added", data: { post } });
});

export const updateInstagramPostHandler = asyncHandler(async (req: Request, res: Response) => {
  const post = await updateInstagramPost(
    String(req.params.id),
    req.body as UpdateInstagramPostInput,
    req.userId
  );
  res.status(200).json({ success: true, message: "Instagram post updated", data: { post } });
});

export const updateInstagramPostStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as UpdateInstagramPostStatusInput;
  const post = await setInstagramPostStatus(String(req.params.id), status, req.userId);
  res.status(200).json({ success: true, message: `Instagram post ${status.toLowerCase()}`, data: { post } });
});

export const deleteInstagramPostHandler = asyncHandler(async (req: Request, res: Response) => {
  await archiveInstagramPost(String(req.params.id), req.userId);
  res.status(200).json({ success: true, message: "Instagram post archived" });
});
