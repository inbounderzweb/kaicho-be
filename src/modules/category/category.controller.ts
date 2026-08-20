import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  createCategory,
  getCategoryList,
  getCategoryOptions,
  getCategoryById,
  updateCategoryById,
  deleteCategoryById,
} from "./category.service";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation";

export const createCategoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as CreateCategoryInput;
  const category = await createCategory(input);
  res.status(201).json({ success: true, message: "Category created", data: { category } });
});

export const getCategoryListHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await getCategoryList({
    page,
    pageSize,
    search: req.query.search,
    parentId: req.query.parentId,
    isActive: req.query.isActive,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getCategoryOptionsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const options = await getCategoryOptions();
  res.status(200).json({ success: true, data: options });
});

export const getCategoryDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const category = await getCategoryById(String(req.params.id));
  if (!category) {
    throw new AppError("Category not found", 404);
  }
  res.status(200).json({ success: true, data: { category } });
});

export const updateCategoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateCategoryInput;
  const category = await updateCategoryById(String(req.params.id), patch);
  if (!category) {
    throw new AppError("Category not found", 404);
  }
  res.status(200).json({ success: true, message: "Category updated", data: { category } });
});

export const deleteCategoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await deleteCategoryById(String(req.params.id));
  if (result === null) {
    throw new AppError("Category not found", 404);
  }
  res.status(200).json({ success: true, message: "Category deleted" });
});
