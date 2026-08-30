import crypto from "crypto";
import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Order,
  OrderDocument,
  OrderItem,
  OrderPricing,
  OrderShippingAddress,
  OrderStatus,
  OrderPaymentMethod,
  OrderPaymentStatus,
  OrderStatusHistoryEntry,
  ORDER_STATUS_TRANSITIONS,
  Product,
} from "../../database/models";

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

// ---- Order numbers ----
// Human-quotable, date-prefixed, and NOT sequential — a sequential counter
// would need its own collection (an extra write and a contention point on
// every checkout) and would leak total order volume to anyone who places two
// orders. 6 random alphanumerics from a 32-char alphabet is ~10^9 values per
// day, so collisions are vanishingly rare; the unique index catches the ones
// that do happen and the caller simply retries with a fresh number.

// Crockford-ish alphabet: no I/O/0/1, so a customer reading a number off a
// screen to support can't confuse them.
const ORDER_NUMBER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ORDER_NUMBER_ATTEMPTS = 5;

export function generateOrderNumber(now: Date = new Date()): string {
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}`;
  const bytes = crypto.randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += ORDER_NUMBER_ALPHABET[bytes[i] % ORDER_NUMBER_ALPHABET.length];
  }
  return `ORD-${datePart}-${suffix}`;
}

export interface NewOrderPayload {
  userId: mongoose.Types.ObjectId;
  items: OrderItem[];
  pricing: OrderPricing;
  shippingAddress: OrderShippingAddress;
  status: OrderStatus;
  paymentMethod: OrderPaymentMethod;
  paymentStatus: OrderPaymentStatus;
  idempotencyKey?: string;
  statusHistory: OrderStatusHistoryEntry[];
}

export async function createOrderWithUniqueNumber(payload: NewOrderPayload): Promise<OrderDocument> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ORDER_NUMBER_ATTEMPTS; attempt++) {
    try {
      return await Order.create({ ...payload, orderNumber: generateOrderNumber() });
    } catch (err) {
      const candidate = err as { code?: number; keyPattern?: Record<string, unknown> };
      // Only an orderNumber collision is retryable — an idempotencyKey
      // collision means a concurrent duplicate checkout, which the caller
      // handles very differently (return the winner, don't mint a new one).
      if (candidate?.code === 11000 && candidate.keyPattern && "orderNumber" in candidate.keyPattern) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new AppError("Could not generate a unique order number, please retry", 500, true, lastError);
}

// ---- DTOs ----

export function toOrderDto(doc: OrderDocument) {
  return {
    orderId: doc._id.toString(),
    orderNumber: doc.orderNumber,
    items: doc.items.map((item) => ({
      productId: item.productId.toString(),
      name: item.name,
      sku: item.sku,
      imageUrl: item.imageUrl ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      mrp: item.mrp,
      discount: item.discount,
      discountPercentage: item.discountPercentage,
      lineTotal: item.lineTotal,
    })),
    pricing: {
      subtotal: doc.pricing.subtotal,
      shippingFee: doc.pricing.shippingFee,
      taxTotal: doc.pricing.taxTotal,
      grandTotal: doc.pricing.grandTotal,
    },
    shippingAddress: {
      label: doc.shippingAddress.label,
      line1: doc.shippingAddress.line1,
      line2: doc.shippingAddress.line2,
      city: doc.shippingAddress.city,
      state: doc.shippingAddress.state,
      pincode: doc.shippingAddress.pincode,
    },
    status: doc.status,
    paymentMethod: doc.paymentMethod,
    paymentStatus: doc.paymentStatus,
    // Only the gateway's public order id is exposed. razorpayPaymentId /
    // razorpaySignature stay server-side: the signature is a secret-derived
    // value and echoing it back serves no client purpose.
    payment: {
      razorpayOrderId: doc.payment?.razorpayOrderId ?? null,
      paidAt: doc.payment?.paidAt ? doc.payment.paidAt.toISOString() : null,
      refundedAmount: doc.payment?.refundedAmount ?? 0,
    },
    statusHistory: doc.statusHistory.map((entry) => ({
      status: entry.status,
      at: entry.at.toISOString(),
      note: entry.note,
    })),
    cancelReason: doc.cancelReason,
    // What the customer UI needs to decide whether to render a Cancel button
    // — derived from the same transition table the endpoint enforces, so the
    // button can never offer something the server will reject.
    cancellable: ORDER_STATUS_TRANSITIONS[doc.status].includes("CANCELLED"),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ---- Stock restoration ----
// Shared by customer cancel, admin cancel, and the stale-order cleanup job.
// Uses updateOne (not findOneAndUpdate) and swallows per-line failures: a
// product deleted since the order was placed must not block the cancellation
// itself — the customer's order state matters more than a stock counter on a
// row that may not exist any more.
export async function restoreStockForOrder(doc: OrderDocument): Promise<void> {
  for (const item of doc.items) {
    try {
      await Product.updateOne(
        { _id: item.productId, "inventory.trackInventory": true },
        { $inc: { "inventory.stockQuantity": item.quantity } }
      );
    } catch (err) {
      console.error("Stock restore failed", {
        orderNumber: doc.orderNumber,
        productId: item.productId.toString(),
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }
}

// ---- Customer-facing ----

export async function listOrdersForUser(
  userId: string,
  { page, pageSize }: { page: number; pageSize: number }
) {
  const filter = { userId };
  const [docs, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .exec(),
    Order.countDocuments(filter),
  ]);
  return { items: docs.map(toOrderDto), page, pageSize, total };
}

// Always filtered by userId as well as orderNumber. Order numbers are short
// enough to be guessable in bulk, so ownership is enforced in the query
// itself rather than by a post-fetch check that a later refactor could drop.
export async function getOrderForUser(userId: string, orderNumber: string) {
  const doc = await Order.findOne({ userId, orderNumber }).exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }
  return toOrderDto(doc);
}

export async function cancelOrderForUser(userId: string, orderNumber: string, reason?: string) {
  const doc = await Order.findOne({ userId, orderNumber }).exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }

  if (!ORDER_STATUS_TRANSITIONS[doc.status].includes("CANCELLED")) {
    throw new AppError(`An order that is ${humanizeStatus(doc.status)} can no longer be cancelled`, 409);
  }

  await restoreStockForOrder(doc);

  doc.status = "CANCELLED";
  doc.cancelReason = reason;
  doc.statusHistory.push({
    status: "CANCELLED",
    at: new Date(),
    note: reason ?? "Cancelled by customer",
    actor: new mongoose.Types.ObjectId(userId),
  });
  await doc.save();

  return toOrderDto(doc);
}

function humanizeStatus(status: OrderStatus): string {
  return status.toLowerCase().replace(/_/g, " ");
}

// ---- Admin ----

export async function listOrdersAdmin(params: {
  page: number;
  pageSize: number;
  status?: unknown;
  paymentStatus?: unknown;
  search?: unknown;
}) {
  const filter: Record<string, unknown> = {};

  // Enum membership is checked against the model's own arrays rather than
  // passing the raw query value into the filter.
  if (typeof params.status === "string" && (ORDER_STATUS_TRANSITIONS as Record<string, unknown>)[params.status]) {
    filter.status = params.status;
  }
  if (typeof params.paymentStatus === "string") {
    const allowed: OrderPaymentStatus[] = ["PENDING", "PAID", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"];
    if (allowed.includes(params.paymentStatus as OrderPaymentStatus)) {
      filter.paymentStatus = params.paymentStatus;
    }
  }
  if (typeof params.search === "string" && params.search.trim()) {
    filter.orderNumber = new RegExp(escapeRegex(params.search.trim()), "i");
  }

  const [docs, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((params.page - 1) * params.pageSize)
      .limit(params.pageSize)
      // Untyped populate on purpose: the typed generic rewrites userId's
      // type on the whole document, which then no longer satisfies
      // OrderDocument for the mappers below. customerLabel() narrows the
      // populated-or-not union itself.
      .populate("userId", "firstName lastName phone")
      .exec(),
    Order.countDocuments(filter),
  ]);

  return {
    items: docs.map(toAdminOrderListItem),
    page: params.page,
    pageSize: params.pageSize,
    total,
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PopulatedCustomer {
  _id: mongoose.Types.ObjectId;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

function customerLabel(userId: unknown): string {
  const user = userId as PopulatedCustomer | mongoose.Types.ObjectId | null;
  if (!user || user instanceof mongoose.Types.ObjectId) return "Unknown customer";
  const populated = user as PopulatedCustomer;
  const name = [populated.firstName, populated.lastName].filter(Boolean).join(" ").trim();
  return name || populated.phone || "Unknown customer";
}

// The admin list DTO the dashboard's orders table renders. Deliberately
// richer than the dummy data it replaces (paymentStatus, orderNumber, real
// ids) — the frontend's AdminOrder type is being widened to match.
export function toAdminOrderListItem(doc: OrderDocument) {
  return {
    id: doc._id.toString(),
    orderNumber: doc.orderNumber,
    customer: customerLabel(doc.userId),
    items: doc.items.length,
    total: doc.pricing.grandTotal,
    status: doc.status,
    paymentStatus: doc.paymentStatus,
    paymentMethod: doc.paymentMethod,
    placedAt: doc.createdAt.toISOString(),
  };
}

export async function getOrderAdmin(orderId: string) {
  if (!isValidObjectId(orderId)) {
    throw new AppError("Order not found", 404);
  }
  const doc = await Order.findById(orderId)
    .populate("userId", "firstName lastName phone email")
    .exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }

  const customer = doc.userId as unknown as (PopulatedCustomer & { email?: string }) | null;
  return {
    ...toOrderDto(doc),
    customer:
      customer && !(customer instanceof mongoose.Types.ObjectId)
        ? {
            userId: customer._id.toString(),
            name: customerLabel(doc.userId),
            phone: customer.phone ?? null,
            email: customer.email ?? null,
          }
        : null,
    // Admin UI renders this as the status dropdown's option list, so the
    // control can only ever offer transitions the server will accept.
    allowedNextStatuses: ORDER_STATUS_TRANSITIONS[doc.status],
  };
}

export async function updateOrderStatusAdmin(
  orderId: string,
  actorId: string | undefined,
  nextStatus: OrderStatus,
  note?: string
) {
  if (!isValidObjectId(orderId)) {
    throw new AppError("Order not found", 404);
  }
  const doc = await Order.findById(orderId).exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }

  if (!ORDER_STATUS_TRANSITIONS[doc.status].includes(nextStatus)) {
    throw new AppError(
      `Cannot move an order from ${humanizeStatus(doc.status)} to ${humanizeStatus(nextStatus)}`,
      409
    );
  }

  // Cancelling from the admin side has to give the stock back for exactly
  // the same reason the customer path does.
  if (nextStatus === "CANCELLED") {
    await restoreStockForOrder(doc);
    doc.cancelReason = note ?? "Cancelled by admin";
  }

  doc.status = nextStatus;
  doc.statusHistory.push({
    status: nextStatus,
    at: new Date(),
    note,
    actor: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
  });
  await doc.save();

  return toOrderDto(doc);
}

// ---- Dashboard aggregates ----

const TREND_DAYS = 14;

// Cancelled orders are excluded from revenue/order counts everywhere — they
// were never money. Refunded ones are NOT excluded here: they were real
// revenue that later reversed, and `payment.refundedAmount` is where that
// reversal is tracked.
const REVENUE_STATUS_FILTER = { status: { $ne: "CANCELLED" } };

export async function getDashboardOrderStats() {
  // UTC day boundaries throughout — $dateToString below buckets in UTC by
  // default, so the JS-side day keys must be built the same way or the two
  // would disagree by a day for part of every day.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (TREND_DAYS - 1));

  const [totals, trendRows, recentDocs] = await Promise.all([
    Order.aggregate<{ _id: null; totalRevenue: number; totalOrders: number }>([
      { $match: REVENUE_STATUS_FILTER },
      { $group: { _id: null, totalRevenue: { $sum: "$pricing.grandTotal" }, totalOrders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; revenue: number; orders: number }>([
      { $match: { ...REVENUE_STATUS_FILTER, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$pricing.grandTotal" },
          orders: { $sum: 1 },
        },
      },
    ]),
    Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("userId", "firstName lastName phone")
      .exec(),
  ]);

  const byDate = new Map(trendRows.map((row) => [row._id, row]));
  // Every one of the last 14 days is emitted, including days with no orders —
  // the chart needs a continuous x-axis, and $group only returns days that
  // actually have documents.
  const trend = Array.from({ length: TREND_DAYS }).map((_, i) => {
    const date = new Date(since);
    date.setUTCDate(since.getUTCDate() + i);
    const key = date.toISOString().slice(0, 10);
    const row = byDate.get(key);
    return { date: key, revenue: row?.revenue ?? 0, orders: row?.orders ?? 0 };
  });

  return {
    stats: {
      totalRevenue: totals[0]?.totalRevenue ?? 0,
      totalOrders: totals[0]?.totalOrders ?? 0,
    },
    trend,
    recentOrders: recentDocs.map(toAdminOrderListItem),
  };
}
