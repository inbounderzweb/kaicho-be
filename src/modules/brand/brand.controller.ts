import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  createBrand,
  getBrandList,
  getBrandOptions,
  getBrandById,
  updateBrandById,
  deleteBrandById,
} from "./brand.service";
import type { CreateBrandInput, UpdateBrandInput } from "./brand.validation";

export const createBrandHandler = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as CreateBrandInput;
  const brand = await createBrand(input, req.userId);
  res.status(201).json({ success: true, message: "Brand created", data: { brand } });
});

export const getBrandListHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await getBrandList({
    page,
    pageSize,
    search: req.query.search,
    isActive: req.query.isActive,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getBrandOptionsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const options = await getBrandOptions();
  res.status(200).json({ success: true, data: options });
});

export const getBrandDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const brand = await getBrandById(String(req.params.id));
  if (!brand) {
    throw new AppError("Brand not found", 404);
  }
  res.status(200).json({ success: true, data: { brand } });
});

export const updateBrandHandler = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateBrandInput;
  const brand = await updateBrandById(String(req.params.id), patch, req.userId);
  if (!brand) {
    throw new AppError("Brand not found", 404);
  }
  res.status(200).json({ success: true, message: "Brand updated", data: { brand } });
});

export const deleteBrandHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await deleteBrandById(String(req.params.id));
  if (result === null) {
    throw new AppError("Brand not found", 404);
  }
  res.status(200).json({ success: true, message: "Brand deleted" });
});
