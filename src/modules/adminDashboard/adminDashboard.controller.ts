import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { countAllUsers } from "./adminUsers.service";
import { countAllProducts } from "../product/product.service";
import { getDashboardOrderStats, listOrdersAdmin } from "../order/order.service";
import { parsePagination } from "./pagination";
import type { DashboardStats } from "./adminDashboard.data";

export const getDashboard = asyncHandler(async (_req: Request, res: Response) => {
  const [orderStats, totalUsers, totalProducts] = await Promise.all([
    getDashboardOrderStats(),
    countAllUsers(),
    countAllProducts(),
  ]);

  const stats: DashboardStats = {
    totalRevenue: orderStats.stats.totalRevenue,
    totalOrders: orderStats.stats.totalOrders,
    totalUsers,
    totalProducts,
  };

  // Response shape is unchanged from the dummy-data version the admin panel
  // already consumes — { stats, trend, recentOrders } — only the source is
  // real now. recentOrders items are richer than the old placeholders
  // (orderNumber, paymentStatus, paymentMethod on top of the original
  // id/customer/items/total/status/placedAt).
  res.status(200).json({
    success: true,
    data: { stats, trend: orderStats.trend, recentOrders: orderStats.recentOrders },
  });
});

export const getOrdersList = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listOrdersAdmin({
    page,
    pageSize,
    status: req.query.status,
    paymentStatus: req.query.paymentStatus,
    search: req.query.search,
  });
  res.status(200).json({ success: true, data });
});
