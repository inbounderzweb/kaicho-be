import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { listBlogTags, createBlogTag, updateBlogTag, deleteBlogTag } from "./blogTag.service";
import type { CreateBlogTagInput, UpdateBlogTagInput } from "./blogTag.validation";

export const listBlogTagsHandler = asyncHandler(async (req: Request, res: Response) => {
  const tags = await listBlogTags(req.query.search);
  res.status(200).json({ success: true, data: { tags } });
});

export const createBlogTagHandler = asyncHandler(async (req: Request, res: Response) => {
  const tag = await createBlogTag((req.body as CreateBlogTagInput).name);
  res.status(201).json({ success: true, message: "Tag created", data: { tag } });
});

export const updateBlogTagHandler = asyncHandler(async (req: Request, res: Response) => {
  const tag = await updateBlogTag(String(req.params.id), (req.body as UpdateBlogTagInput).name);
  if (!tag) throw new AppError("Tag not found", 404);
  res.status(200).json({ success: true, message: "Tag updated", data: { tag } });
});

export const deleteBlogTagHandler = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await deleteBlogTag(String(req.params.id));
  if (deleted === null) throw new AppError("Tag not found", 404);
  res.status(200).json({ success: true, message: "Tag deleted" });
});
