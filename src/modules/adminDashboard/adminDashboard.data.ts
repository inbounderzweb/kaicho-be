// This file used to generate deterministic dummy orders for the admin
// dashboard, because no order-management backend existed. A real Order module
// now does (see modules/order) — `getDashboardOrderStats()` and
// `listOrdersAdmin()` there supply the revenue totals, 14-day trend, recent
// orders, and the paginated orders table, and adminDashboard.controller.ts
// calls them directly. Same swap already applied to `totalUsers`
// (adminUsers.service) and `totalProducts` (product.service).
//
// Nothing dummy remains, so this module now only owns the shape of the
// non-order half of the dashboard payload — the two counts the controller
// fills in from their own services.
export interface DashboardStats {
  totalRevenue: number;
  totalOrders: number;
  totalUsers: number;
  totalProducts: number;
}
