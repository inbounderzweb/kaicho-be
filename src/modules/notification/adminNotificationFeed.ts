import { Types, type PipelineStage } from "mongoose";
import { Order, User } from "../../database/models";

const MAX_ITEMS = 20;
const WINDOW_DAYS = 30;

export interface AdminOrderNotification {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  amount: number;
  itemsCount: number;
  createdAt: string;
  confirmedAt: string;
  unread: boolean;
}

interface FeedOrder {
  _id: { toString(): string };
  orderNumber: string;
  createdAt: Date;
  confirmedAt: Date;
  pricing: { grandTotal: number };
  items: unknown[];
  shippingAddress?: { receiverName?: string };
  customer: { firstName?: string; lastName?: string; phone?: string }[];
  adminNotificationReadBy?: { toString(): string }[];
}

// The confirmation history is the durable source. Socket.IO's in-memory room
// cannot recover events lost during disconnects or emitted on another worker.
// Use the FIRST confirmation so subsequent status changes never create a new
// order alert, and cancelled/fulfilled orders retain their original alert.
export async function listAdminOrderNotifications(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const pipeline: PipelineStage[] = [
    { $match: { statusHistory: { $elemMatch: { status: "CONFIRMED", at: { $gte: since, $lte: now } } } } },
    { $set: { confirmedAt: { $min: { $map: {
      input: { $filter: { input: "$statusHistory", as: "entry", cond: { $eq: ["$$entry.status", "CONFIRMED"] } } },
      as: "entry", in: "$$entry.at",
    } } } } },
    { $match: { confirmedAt: { $gte: since, $lte: now } } },
    { $sort: { confirmedAt: -1, _id: -1 } },
    { $limit: MAX_ITEMS },
    { $lookup: {
      from: User.collection.name,
      localField: "userId", foreignField: "_id", as: "customer",
      pipeline: [{ $project: { firstName: 1, lastName: 1, phone: 1 } }],
    } },
    { $project: { orderNumber: 1, createdAt: 1, confirmedAt: 1, pricing: 1, items: 1, shippingAddress: 1, customer: 1, adminNotificationReadBy: 1 } },
  ];
  const orders = await Order.aggregate<FeedOrder>(pipeline);
  const items: AdminOrderNotification[] = orders.map((order) => {
    const customer = order.customer[0];
    const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim()
      || order.shippingAddress?.receiverName || customer?.phone || "Customer";
    return {
      id: order._id.toString(),
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      customerName,
      amount: order.pricing.grandTotal,
      itemsCount: order.items.length,
      createdAt: order.createdAt.toISOString(),
      confirmedAt: order.confirmedAt.toISOString(),
      unread: !order.adminNotificationReadBy?.some((adminId) => adminId.toString() === userId),
    };
  });
  return { items, unreadCount: items.filter((item) => item.unread).length };
}

export async function markAdminOrderNotificationsRead(userId: string, orderIds: string[]): Promise<void> {
  // A confirmation timestamp may be allocated before its DB write commits.
  // Acknowledge only observed IDs so an unseen delayed/same-ms commit stays unread.
  // addToSet makes overlapping requests from multiple admin tabs idempotent.
  await Order.updateMany(
    { _id: { $in: orderIds }, "statusHistory.status": "CONFIRMED" },
    { $addToSet: { adminNotificationReadBy: new Types.ObjectId(userId) } },
    { timestamps: false },
  );
}
