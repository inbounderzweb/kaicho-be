import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePublicPagination } from "../../common/utils/publicPagination";
import { getPublicCategoryList, getPublicCategoryBySlug } from "./category.service";
import { getPublicProductList } from "../product/product.service";

export const getPublicCategoryListHandler = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await getPublicCategoryList();
  res.status(200).json({ success: true, data: { categories } });
});

export const getPublicCategoryDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const category = await getPublicCategoryBySlug(String(req.params.slug));
  if (!category) {
    throw new AppError("Category not found", 404);
  }
  res.status(200).json({ success: true, data: { category } });
});

// GET /api/categories/:slug/products — the category landing page's product
// grid. Delegates straight to the same getPublicProductList() the /products
// listing uses (categorySlug pinned from the route param instead of a query
// param) rather than a parallel implementation, per spec §25 ("use the same
// reusable product listing... do not duplicate").
export const getPublicCategoryProductsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePublicPagination(req);
  const data = await getPublicProductList({
    page,
    pageSize,
    search: req.query.search,
    categorySlug: req.params.slug,
    brandSlug: req.query.brand,
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    inStock: req.query.inStock,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});
