// This file used to generate deterministic dummy orders for the admin
// dashboard, because no order-management backend existed. A real Order module
// now does (see modules/order) — `getDashboardOrderStats()` and
// `listOrdersAdmin()` there supply the revenue totals, 14-day trend, recent
// orders, status breakdown, top products, and the paginated orders table, and
// adminDashboard.controller.ts calls them directly. Same swap already applied
// to `totalUsers` (adminUsers.service) and `totalProducts` (product.service).
//
// Nothing dummy remains, so this module now only owns the *shape* of the
// dashboard payload — everything below is filled from real aggregates by the
// controller in a single endpoint call.
export interface DashboardStats {
  /** All-time, cancelled orders excluded. */
  totalRevenue: number;
  totalOrders: number;
  /** Rolling 30-day window. */
  revenue30d: number;
  orders30d: number;
  /** All-time revenue / orders. */
  averageOrderValue: number;
  /** Paid but not yet shipped (CONFIRMED + PROCESSING) — needs admin action. */
  pendingOrders: number;
  totalUsers: number;
  /** New signups in the last 30 days. */
  newUsers30d: number;
  totalProducts: number;
  /** Tracked products at or below their low-stock threshold. */
  lowStockProducts: number;
  /** Posts with status PUBLISHED. */
  publishedBlogs: number;
}
