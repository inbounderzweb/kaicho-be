import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  listBlogsAdmin,
  getBlogAdmin,
  createBlog,
  updateBlog,
  setBlogStatus,
  duplicateBlog,
  deleteBlog,
  bulkBlogAction,
  listBlogsPublic,
  getBlogPublic,
  getRelatedBlogsPublic,
} from "./blog.service";
import type {
  CreateBlogInput,
  UpdateBlogInput,
  BlogStatusInput,
  BlogScheduleInput,
  BulkBlogActionInput,
} from "./blog.validation";

// ---- Admin ----

export const listBlogsAdminHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listBlogsAdmin({
    page,
    pageSize,
    status: req.query.status,
    categoryId: req.query.categoryId,
    author: req.query.author,
    tag: req.query.tag,
    seoStatus: req.query.seoStatus,
    search: req.query.search,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    sort: req.query.sort,
  });
  res.status(200).json({ success: true, data });
});

export const getBlogAdminHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await getBlogAdmin(String(req.params.id));
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, data: { blog } });
});

export const createBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await createBlog(req.body as CreateBlogInput, req.userId);
  res.status(201).json({ success: true, message: "Blog created", data: { blog } });
});

export const updateBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await updateBlog(String(req.params.id), req.body as UpdateBlogInput, req.userId);
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, message: "Blog updated", data: { blog } });
});

export const setBlogStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as BlogStatusInput;
  const blog = await setBlogStatus(String(req.params.id), body.status, {
    actorId: req.userId,
    scheduledFor: body.scheduledFor,
    note: body.note,
  });
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, message: "Blog status updated", data: { blog } });
});

export const publishBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await setBlogStatus(String(req.params.id), "PUBLISHED", { actorId: req.userId });
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, message: "Blog published", data: { blog } });
});

export const unpublishBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await setBlogStatus(String(req.params.id), "DRAFT", { actorId: req.userId });
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, message: "Blog unpublished", data: { blog } });
});

export const archiveBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await setBlogStatus(String(req.params.id), "ARCHIVED", { actorId: req.userId });
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, message: "Blog archived", data: { blog } });
});

export const scheduleBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as BlogScheduleInput;
  const blog = await setBlogStatus(String(req.params.id), "SCHEDULED", {
    actorId: req.userId,
    scheduledFor: body.scheduledFor,
    note: body.note,
  });
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(200).json({ success: true, message: "Blog scheduled", data: { blog } });
});

export const duplicateBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const blog = await duplicateBlog(String(req.params.id), req.userId);
  if (!blog) throw new AppError("Blog not found", 404);
  res.status(201).json({ success: true, message: "Blog duplicated", data: { blog } });
});

export const deleteBlogHandler = asyncHandler(async (req: Request, res: Response) => {
  const hard = req.query.hard === "true";
  const result = await deleteBlog(String(req.params.id), { hard, actorId: req.userId });
  if (result === null) throw new AppError("Blog not found", 404);
  res.status(200).json({
    success: true,
    message: hard ? "Blog permanently deleted" : "Blog archived",
    ...(hard ? {} : { data: { blog: result } }),
  });
});

export const bulkBlogActionHandler = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as BulkBlogActionInput;
  const result = await bulkBlogAction(body.ids, body.action, req.userId);
  res.status(200).json({ success: true, message: "Bulk action complete", data: result });
});

// ---- Public ----

export const listBlogsPublicHandler = asyncHandler(async (req: Request, res: Response) => {
  const data = await listBlogsPublic({
    page: req.query.page,
    pageSize: req.query.pageSize,
    category: req.query.category,
    tag: req.query.tag,
    search: req.query.search,
  });
  res.status(200).json({ success: true, data });
});

export const getBlogPublicHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await getBlogPublic(String(req.params.slug));
  if (!result) throw new AppError("Blog not found", 404);
  res.status(200).json({
    success: true,
    data: { blog: result.post, redirectedFrom: result.redirectedFrom },
  });
});

export const getRelatedBlogsPublicHandler = asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(6, Math.max(1, parseInt(String(req.query.limit ?? "3"), 10) || 3));
  const blogs = await getRelatedBlogsPublic(String(req.params.slug), limit);
  res.status(200).json({ success: true, data: { blogs } });
});
