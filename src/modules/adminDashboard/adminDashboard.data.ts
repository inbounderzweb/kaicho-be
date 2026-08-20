// Deterministic dummy data for the admin panel's initial dashboard/orders
// lists. No backend order-management system exists yet — this mirrors the
// same "static placeholder" treatment already used on the customer-facing
// profile/orders sections, kept deterministic (not re-randomized per
// request) so the UI doesn't visibly jitter on refetch.
//
// Product data is NO LONGER generated here — a real Product module now
// exists (see modules/product). `stats.totalProducts` below is a
// placeholder that adminDashboard.controller.ts overwrites with a real
// Product.countDocuments() count, the same way it already overwrites
// `stats.totalUsers` with a real count from adminUsers.service.

function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

const CUSTOMER_NAMES = [
  "Rohan Sharma",
  "Ananya Iyer",
  "Vikram Rao",
  "Priya Nair",
  "Arjun Mehta",
  "Sneha Kapoor",
  "Karan Malhotra",
  "Divya Menon",
  "Rahul Verma",
  "Isha Reddy",
];

const ORDER_STATUSES = ["Processing", "On the way", "Delivered", "Cancelled"] as const;

export function getDashboardSummary() {
  const trend = Array.from({ length: 14 }).map((_, i) => {
    const base = 18000 + Math.round(seededRandom(i + 1) * 9000);
    const orders = 40 + Math.round(seededRandom(i + 50) * 35);
    const date = new Date();
    date.setDate(date.getDate() - (13 - i));
    return {
      date: date.toISOString().slice(0, 10),
      revenue: base,
      orders,
    };
  });

  const totalRevenue = trend.reduce((sum, d) => sum + d.revenue, 0);
  const totalOrders = trend.reduce((sum, d) => sum + d.orders, 0);

  return {
    stats: {
      totalRevenue,
      totalOrders,
      totalUsers: 1284,
      totalProducts: 0,
    },
    trend,
    recentOrders: getOrders({ page: 1, pageSize: 5 }).items,
  };
}

export function getOrders({ page = 1, pageSize = 10 }: { page?: number; pageSize?: number }) {
  const total = 68;
  const start = (page - 1) * pageSize;
  const items = Array.from({ length: Math.min(pageSize, Math.max(total - start, 0)) }).map(
    (_, i) => {
      const idx = start + i;
      const itemCount = 1 + (idx % 3);
      return {
        id: `KC${73000 - idx}`,
        customer: CUSTOMER_NAMES[idx % CUSTOMER_NAMES.length],
        items: itemCount,
        total: 280 + Math.round(seededRandom(idx + 400) * 900),
        status: ORDER_STATUSES[idx % ORDER_STATUSES.length],
        placedAt: new Date(Date.now() - idx * 8 * 60 * 60 * 1000).toISOString(),
      };
    }
  );
  return { items, page, pageSize, total };
}
