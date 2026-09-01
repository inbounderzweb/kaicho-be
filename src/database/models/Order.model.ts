import { Schema, model, Document, Types } from "mongoose";

// An Order is an immutable-ish *snapshot* of what the customer bought, not a
// set of live references. Line items copy name/sku/imageUrl/prices at the
// moment of purchase and `shippingAddress` is a copy of the chosen
// User.addresses entry rather than a ref — the product can be renamed or
// repriced, and the address book entry edited or deleted, without ever
// rewriting order history.
//
// Payment lives embedded here rather than in a separate Payment collection,
// matching Product's embedded pricing/inventory/seo style. Webhook/verify
// idempotency is enforced by guarding transitions ("only act if not already
// PAID/REFUNDED") rather than by a processed-events table — the payment
// state itself is the dedupe key.

export const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "RETURN_REQUESTED",
  "RETURNED",
  "REFUNDED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_PAYMENT_METHODS = ["RAZORPAY", "COD"] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export const ORDER_PAYMENT_STATUSES = [
  "PENDING",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

// Shipment status is deliberately *subordinate* to `status` above: it carries
// finer-grained logistics detail (Packed / In transit / Failed delivery have
// no equivalent order state) and the admin can correct it freely, so it has
// no transition table of its own. Moving it forward auto-advances `status`
// along the fulfilment happy path (see shipment.service.ts) — the order
// lifecycle stays the single source of truth for anything money/stock-related.
export const SHIPMENT_STATUSES = [
  "ORDER_CONFIRMED",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "FAILED_DELIVERY",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

// The ordered happy-path steps the customer's visual timeline renders. The two
// exception states (CANCELLED, FAILED_DELIVERY) are intentionally absent — the
// UI shows a callout for those rather than a step.
export const SHIPMENT_TIMELINE_STEPS: ShipmentStatus[] = [
  "ORDER_CONFIRMED",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

// The single source of truth for what status change is legal, shared by the
// customer cancel endpoint, the admin status-update endpoint, and the stale
// pending-order cleanup job — an explicit table rather than ad-hoc if/else
// scattered across three call sites. Anything not listed is a 409.
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: ["RETURN_REQUESTED"],
  // RETURNED accepts the return; DELIVERED is the "return rejected, item
  // stays with the customer" path back.
  RETURN_REQUESTED: ["RETURNED", "DELIVERED"],
  RETURNED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

// Statuses whose stock was decremented at checkout and is still "held" by
// this order — cancelling out of any of these must give the stock back.
export const ORDER_STATUSES_HOLDING_STOCK: OrderStatus[] = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

export interface OrderItem {
  productId: Types.ObjectId;
  name: string;
  sku: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: number;
  mrp: number;
  discount: number;
  discountPercentage: number;
  lineTotal: number;
}

export interface OrderPricing {
  subtotal: number;
  shippingFee: number;
  taxTotal: number;
  grandTotal: number;
}

export interface OrderShippingAddress {
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface OrderPayment {
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  paidAt?: Date;
  refundedAmount?: number;
}

export interface OrderStatusHistoryEntry {
  status: OrderStatus;
  at: Date;
  note?: string;
  actor?: Types.ObjectId;
}

export interface OrderShipmentHistoryEntry {
  status: ShipmentStatus;
  at: Date;
  note?: string;
}

export interface OrderShipment {
  // Delivery partner / courier name and the AWB (airway bill) tracking number
  // the customer would quote to the courier. Both are required for a shipment
  // to exist at all.
  carrier: string;
  trackingNumber: string;
  // The aggregator's own shipment id (Shiprocket etc.) — distinct from the
  // AWB, and absent for a manually-entered shipment.
  shipmentId?: string;
  status: ShipmentStatus;
  shippedAt?: Date;
  estimatedDeliveryAt?: Date;
  deliveredAt?: Date;
  trackingUrl?: string;
  // Which system created/owns this shipment. "manual" for admin-entered; a
  // future courier-aggregator integration sets its own name here without any
  // other schema change.
  provider: string;
  history: OrderShipmentHistoryEntry[];
  notes?: string;
}

export interface OrderDocument extends Document {
  orderNumber: string;
  userId: Types.ObjectId;
  items: OrderItem[];
  pricing: OrderPricing;
  shippingAddress: OrderShippingAddress;
  status: OrderStatus;
  paymentMethod: OrderPaymentMethod;
  paymentStatus: OrderPaymentStatus;
  payment?: OrderPayment;
  shipment?: OrderShipment;
  idempotencyKey?: string;
  statusHistory: OrderStatusHistoryEntry[];
  cancelReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<OrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    imageUrl: { type: String, default: null },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    discountPercentage: { type: Number, required: true, min: 0, default: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const OrderPricingSchema = new Schema<OrderPricing>(
  {
    subtotal: { type: Number, required: true, min: 0 },
    shippingFee: { type: Number, required: true, min: 0, default: 0 },
    taxTotal: { type: Number, required: true, min: 0, default: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const OrderShippingAddressSchema = new Schema<OrderShippingAddress>(
  {
    label: { type: String },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
  },
  { _id: false }
);

// `default: undefined` for the same reason MediaVariantsSchema uses it —
// otherwise Mongoose auto-vivifies `payment` as `{}` on every COD order,
// making `order.payment ? ... : ...` checks meaningless.
const OrderPaymentSchema = new Schema<OrderPayment>(
  {
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    paidAt: { type: Date },
    refundedAmount: { type: Number, min: 0 },
  },
  { _id: false }
);

const OrderStatusHistorySchema = new Schema<OrderStatusHistoryEntry>(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

const OrderShipmentHistorySchema = new Schema<OrderShipmentHistoryEntry>(
  {
    status: { type: String, enum: SHIPMENT_STATUSES, required: true },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String },
  },
  { _id: false }
);

// `default: undefined` for the same reason OrderPaymentSchema uses it — an
// order has no shipment until an admin creates one, and auto-vivifying `{}`
// would make `order.shipment ? ... : ...` checks meaningless.
const OrderShipmentSchema = new Schema<OrderShipment>(
  {
    carrier: { type: String, required: true, trim: true },
    trackingNumber: { type: String, required: true, trim: true },
    shipmentId: { type: String, trim: true },
    status: { type: String, enum: SHIPMENT_STATUSES, required: true },
    shippedAt: { type: Date },
    estimatedDeliveryAt: { type: Date },
    deliveredAt: { type: Date },
    trackingUrl: { type: String, trim: true },
    provider: { type: String, required: true, default: "manual" },
    history: { type: [OrderShipmentHistorySchema], default: [] },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const OrderSchema = new Schema<OrderDocument>(
  {
    orderNumber: { type: String, required: true, unique: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    items: {
      type: [OrderItemSchema],
      required: true,
      validate: {
        validator: (value: OrderItem[]) => Array.isArray(value) && value.length > 0,
        message: "An order must contain at least one item",
      },
    },

    pricing: { type: OrderPricingSchema, required: true },
    shippingAddress: { type: OrderShippingAddressSchema, required: true },

    status: { type: String, enum: ORDER_STATUSES, default: "PENDING_PAYMENT" },
    paymentMethod: { type: String, enum: ORDER_PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: ORDER_PAYMENT_STATUSES, default: "PENDING" },

    payment: { type: OrderPaymentSchema, default: undefined },
    shipment: { type: OrderShipmentSchema, default: undefined },

    // Sparse so orders created by any future non-checkout path (admin
    // manual entry, imports) without a key don't collide on `null`.
    idempotencyKey: { type: String, unique: true, sparse: true },

    statusHistory: { type: [OrderStatusHistorySchema], default: [] },
    cancelReason: { type: String },
  },
  { timestamps: true }
);

OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ createdAt: -1 });
// Webhook lookups arrive keyed only by Razorpay's own ids.
OrderSchema.index({ "payment.razorpayOrderId": 1 });
OrderSchema.index({ "payment.razorpayPaymentId": 1 });
// Support "find the order for this AWB" (customer-support lookups, and a
// future courier webhook that only carries the tracking number).
OrderSchema.index({ "shipment.trackingNumber": 1 });

export const Order = model<OrderDocument>("Order", OrderSchema);
