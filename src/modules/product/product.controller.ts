import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  createProduct,
  getProductList,
  getProductById,
  updateProductById,
  deleteProductById,
  duplicateProductById,
} from "./product.service";
import type { CreateProductInput, UpdateProductInput } from "./product.validation";

export const createProductHandler = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as CreateProductInput;
  const product = await createProduct(input, req.userId);
  res.status(201).json({ success: true, message: "Product created", data: { product } });
});

export const getProductListHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await getProductList({
    page,
    pageSize,
    search: req.query.search,
    categoryId: req.query.categoryId,
    brandId: req.query.brandId,
    status: req.query.status,
    isFeatured: req.query.isFeatured,
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    inStock: req.query.inStock,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getProductDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const product = await getProductById(String(req.params.id));
  if (!product) {
    throw new AppError("Product not found", 404);
  }
  res.status(200).json({ success: true, data: { product } });
});

export const updateProductHandler = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateProductInput;
  const product = await updateProductById(String(req.params.id), patch, req.userId);
  if (!product) {
    throw new AppError("Product not found", 404);
  }
  res.status(200).json({ success: true, message: "Product updated", data: { product } });
});

export const deleteProductHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await deleteProductById(String(req.params.id), req.userId);
  if (result === null) {
    throw new AppError("Product not found", 404);
  }
  res.status(200).json({
    success: true,
    message: result.archived ? "Product archived" : "Product deleted",
    data: result,
  });
});

export const duplicateProductHandler = asyncHandler(async (req: Request, res: Response) => {
  const product = await duplicateProductById(String(req.params.id), req.userId);
  if (!product) {
    throw new AppError("Product not found", 404);
  }
  res.status(201).json({ success: true, message: "Product duplicated", data: { product } });
});
