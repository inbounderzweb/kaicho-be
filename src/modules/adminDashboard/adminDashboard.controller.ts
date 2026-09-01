import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { countAllUsers, countUsersSince } from "./adminUsers.service";
import { countAllProducts, countLowStockProducts } from "../product/product.service";
import { countPublishedBlogs } from "../blog/blog.service";
import { getDashboardOrderStats, listOrdersAdmin } from "../order/order.service";
import { parsePagination } from "./pagination";
import type { DashboardStats } from "./adminDashboard.data";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// The admin dashboard is a SINGLE endpoint on purpose — one call fans out to
// every domain service in parallel here and returns the whole payload, so the
// client never has to orchestrate several requests.
export const getDashboard = asyncHandler(async (_req: Request, res: Response) => {
  const [orderStats, totalUsers, newUsers30d, totalProducts, lowStockProducts, publishedBlogs] =
    await Promise.all([
      getDashboardOrderStats(),
      countAllUsers(),
      countUsersSince(new Date(Date.now() - THIRTY_DAYS_MS)),
      countAllProducts(),
      countLowStockProducts(),
      countPublishedBlogs(),
    ]);

  const stats: DashboardStats = {
    totalRevenue: orderStats.stats.totalRevenue,
    totalOrders: orderStats.stats.totalOrders,
    revenue30d: orderStats.stats.revenue30d,
    orders30d: orderStats.stats.orders30d,
    averageOrderValue: orderStats.stats.averageOrderValue,
    pendingOrders: orderStats.stats.pendingOrders,
    totalUsers,
    newUsers30d,
    totalProducts,
    lowStockProducts,
    publishedBlogs,
  };

  res.status(200).json({
    success: true,
    data: {
      stats,
      trend: orderStats.trend,
      recentOrders: orderStats.recentOrders,
      ordersByStatus: orderStats.ordersByStatus,
      topProducts: orderStats.topProducts,
    },
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
