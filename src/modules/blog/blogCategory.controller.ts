import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import {
  listBlogCategoriesAdmin,
  listBlogCategoryOptions,
  getBlogCategoryById,
  createBlogCategory,
  updateBlogCategory,
  deleteBlogCategory,
  listBlogCategoriesPublic,
  getBlogCategoryBySlugPublic,
} from "./blogCategory.service";
import type { CreateBlogCategoryInput, UpdateBlogCategoryInput } from "./blogCategory.validation";

// ---- Admin ----

export const listBlogCategoriesAdminHandler = asyncHandler(async (req: Request, res: Response) => {
  const categories = await listBlogCategoriesAdmin({ search: req.query.search, status: req.query.status });
  res.status(200).json({ success: true, data: { categories } });
});

export const listBlogCategoryOptionsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const options = await listBlogCategoryOptions();
  res.status(200).json({ success: true, data: options });
});

export const getBlogCategoryAdminHandler = asyncHandler(async (req: Request, res: Response) => {
  const category = await getBlogCategoryById(String(req.params.id));
  if (!category) throw new AppError("Blog category not found", 404);
  res.status(200).json({ success: true, data: { category } });
});

export const createBlogCategoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const category = await createBlogCategory(req.body as CreateBlogCategoryInput);
  res.status(201).json({ success: true, message: "Blog category created", data: { category } });
});

export const updateBlogCategoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const category = await updateBlogCategory(String(req.params.id), req.body as UpdateBlogCategoryInput);
  if (!category) throw new AppError("Blog category not found", 404);
  res.status(200).json({ success: true, message: "Blog category updated", data: { category } });
});

export const deleteBlogCategoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await deleteBlogCategory(String(req.params.id));
  if (deleted === null) throw new AppError("Blog category not found", 404);
  res.status(200).json({ success: true, message: "Blog category deleted" });
});

// ---- Public ----

export const listBlogCategoriesPublicHandler = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await listBlogCategoriesPublic();
  res.status(200).json({ success: true, data: { categories } });
});

export const getBlogCategoryPublicHandler = asyncHandler(async (req: Request, res: Response) => {
  const category = await getBlogCategoryBySlugPublic(String(req.params.slug));
  if (!category) throw new AppError("Blog category not found", 404);
  res.status(200).json({ success: true, data: { category } });
});
