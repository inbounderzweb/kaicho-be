import { Types } from "mongoose";
import { Order, User, type OrderStatus } from "../../database/models";
import { NOTIFY_STATUSES } from "../order/orderStatusNotification";

// A customer's notifications are DERIVED from their orders' statusHistory:
// every admin status change is already recorded there with a timestamp and the
// actor, so there is no separate notifications collection to write, grow or
// keep in sync. The only extra state is User.notificationsSeenAt.

const WINDOW_DAYS = 30;
const MAX_ORDERS = 30;
const MAX_ITEMS = 20;

const MESSAGES: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: "has been confirmed",
  PROCESSING: "is being prepared",
  SHIPPED: "has been shipped",
  OUT_FOR_DELIVERY: "is out for delivery",
  DELIVERED: "has been delivered",
  CANCELLED: "has been cancelled",
  RETURNED: "return has been received",
  REFUNDED: "has been refunded",
};

export interface CustomerNotification {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  message: string;
  at: string;
  unread: boolean;
  /** Courier + AWB, only on shipped / out-for-delivery updates. */
  tracking?: { carrier: string; trackingNumber: string };
}

export async function listNotifications(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const uid = new Types.ObjectId(userId);

  const [orders, user] = await Promise.all([
    // Served by the {userId, createdAt} index; bounded per customer.
    Order.find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(MAX_ORDERS)
      .select("orderNumber status statusHistory shipment.carrier shipment.trackingNumber")
      .lean(),
    User.findById(uid).select("notificationsSeenAt").lean(),
  ]);
  const seenAt = user?.notificationsSeenAt ?? null;

  const items: CustomerNotification[] = [];
  for (const order of orders) {
    for (const entry of order.statusHistory ?? []) {
      if (!entry.status || !entry.at || entry.at < since) continue;
      if (!NOTIFY_STATUSES.has(entry.status)) continue;
      // Successful placement is an acknowledgement even if the customer
      // initiated it; their own cancellation / return action is already known.
      if (entry.status !== "CONFIRMED" && entry.actor && entry.actor.toString() === userId) continue;
      const showTracking =
        (entry.status === "SHIPPED" || entry.status === "OUT_FOR_DELIVERY") &&
        order.shipment?.carrier &&
        order.shipment?.trackingNumber;
      items.push({
        id: `${order.orderNumber}:${entry.status}:${entry.at.getTime()}`,
        orderNumber: order.orderNumber,
        status: entry.status,
        message: MESSAGES[entry.status] ?? "was updated",
        at: entry.at.toISOString(),
        unread: !seenAt || entry.at > seenAt,
        ...(showTracking
          ? { tracking: { carrier: order.shipment!.carrier, trackingNumber: order.shipment!.trackingNumber } }
          : {}),
      });
    }
  }

  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  const top = items.slice(0, MAX_ITEMS);
  return { items: top, unreadCount: top.filter((i) => i.unread).length };
}

export async function markAllRead(userId: string, now = new Date()): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { notificationsSeenAt: now } });
}
