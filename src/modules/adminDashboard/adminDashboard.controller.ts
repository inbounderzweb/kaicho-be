import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { getDashboardSummary, getOrders } from "./adminDashboard.data";
import { countAllUsers } from "./adminUsers.service";
import { countAllProducts } from "../product/product.service";
import { parsePagination } from "./pagination";

export const getDashboard = asyncHandler(async (_req: Request, res: Response) => {
  const [summary, totalUsers, totalProducts] = await Promise.all([
    getDashboardSummary(),
    countAllUsers(),
    countAllProducts(),
  ]);
  res.status(200).json({
    success: true,
    data: { ...summary, stats: { ...summary.stats, totalUsers, totalProducts } },
  });
});

export const getOrdersList = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: getOrders(parsePagination(req)) });
});
