import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePublicPagination } from "../../common/utils/publicPagination";
import { getPublicProductList, getPublicProductBySlug, getRelatedProducts } from "./product.service";

// Query params map 1:1 onto product.service.ts's PublicProductListParams,
// which itself only ever builds a MongoDB filter from a fixed allowlist of
// fields (see buildPublicFilter/buildPublicSort) — nothing here is passed
// through to Mongo unvalidated.
export const getPublicProductListHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePublicPagination(req);
  const data = await getPublicProductList({
    page,
    pageSize,
    search: req.query.search,
    categorySlug: req.query.category,
    brandSlug: req.query.brand,
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    inStock: req.query.inStock,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getPublicProductDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const product = await getPublicProductBySlug(String(req.params.slug));
  if (!product) {
    // Deliberately the same 404 for "doesn't exist" and "exists but is
    // DRAFT/INACTIVE/ARCHIVED" — spec §33: prefer a proper 404 for
    // non-visible products rather than leaking their existence/status.
    throw new AppError("Product not found", 404);
  }
  res.status(200).json({ success: true, data: { product } });
});

export const getRelatedProductsHandler = asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(12, Math.max(1, parseInt(String(req.query.limit ?? "8"), 10) || 8));
  const products = await getRelatedProducts(String(req.params.slug), limit);
  res.status(200).json({ success: true, data: { products } });
});
