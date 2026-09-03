import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Product, Order, OrderDocument, OrderItem } from "../../database/models";
import { computeDiscount, getPrimaryImageUrlMap } from "../product/product.service";
import { getAddressOrThrow } from "../address/address.service";
import { createOrderWithUniqueNumber, toOrderDto } from "../order/order.service";
import { createRazorpayOrder } from "../../common/payments/razorpay";
import { getShippingPolicy } from "../settings/settings.service";
import type { CheckoutPreviewInput, CreateCheckoutInput } from "./checkout.validation";

// The shipping policy is now admin-configurable — the live values come from
// the StoreSettings document (getShippingPolicy()), read once per
// preview/checkout below. These two constants remain as the seed defaults
// (kept in sync with STORE_SETTINGS_DEFAULTS) and the fallback
// computeOrderTotals() uses when no policy is passed — which is how the unit
// tests still call it directly.
export const FREE_SHIPPING_THRESHOLD = 499;
export const FLAT_SHIPPING_FEE = 49;

export interface ShippingPolicy {
  freeShippingThreshold: number;
  flatShippingFee: number;
}

const DEFAULT_SHIPPING_POLICY: ShippingPolicy = {
  freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
  flatShippingFee: FLAT_SHIPPING_FEE,
};

// The ONE place order money is totalled, for both preview and real checkout.
// taxTotal is 0 today: sellingPrice is treated as tax-inclusive (typical for
// Indian D2C listings) and no tax engine is configured — when GST breakout is
// needed it grows here and every caller inherits it for free.
export function computeOrderTotals(
  lineTotals: number[],
  policy: ShippingPolicy = DEFAULT_SHIPPING_POLICY
): {
  subtotal: number;
  shippingFee: number;
  taxTotal: number;
  grandTotal: number;
} {
  // Summed in integer paise, then converted back once — the same
  // integer-minor-units rule computeDiscount() follows, so a cart of
  // fractional-rupee lines can't drift a paisa per line.
  const subtotalMinor = lineTotals.reduce((sum, value) => sum + Math.round(value * 100), 0);
  const subtotal = subtotalMinor / 100;
  const shippingFee = subtotal >= policy.freeShippingThreshold ? 0 : policy.flatShippingFee;
  const taxTotal = 0;
  const grandTotal = (subtotalMinor + Math.round(shippingFee * 100) + Math.round(taxTotal * 100)) / 100;
  return { subtotal, shippingFee, taxTotal, grandTotal };
}

function lineTotalFor(unitPrice: number, quantity: number): number {
  return (Math.round(unitPrice * 100) * quantity) / 100;
}

interface RequestedLine {
  productId: string;
  quantity: number;
}

type PricedProduct = {
  _id: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  status: string;
  pricing: { mrp: number; sellingPrice: number };
  inventory: { stockQuantity: number; trackInventory: boolean };
};

async function loadProducts(items: RequestedLine[]): Promise<Map<string, PricedProduct>> {
  const docs = await Product.find({ _id: { $in: items.map((i) => i.productId) } })
    .select("name sku status pricing inventory")
    .lean();
  return new Map(docs.map((d) => [d._id.toString(), d as unknown as PricedProduct]));
}

// ---- Preview ----
// Pure read/compute — never mutates stock. Its job is to tell the checkout UI
// what the server actually believes about every line (current price, current
// availability) BEFORE the customer commits, so "price changed since you
// added this" / "only 2 left" can be shown instead of a surprise 409 at
// submit time. Unavailable lines are flagged, not thrown on, for exactly
// that reason.
export async function previewCheckout(input: CheckoutPreviewInput) {
  const products = await loadProducts(input.items);
  const imageUrls = await getPrimaryImageUrlMap(input.items.map((i) => i.productId));
  const shippingPolicy = await getShippingPolicy();

  const items = input.items.map((line) => {
    const product = products.get(line.productId);

    if (!product) {
      return {
        productId: line.productId,
        name: null,
        sku: null,
        imageUrl: null,
        quantity: line.quantity,
        unitPrice: 0,
        mrp: 0,
        discount: 0,
        discountPercentage: 0,
        lineTotal: 0,
        unavailable: true,
        insufficientStock: false,
        availableQuantity: 0,
      };
    }

    const { discount, discountPercentage } = computeDiscount(
      product.pricing.mrp,
      product.pricing.sellingPrice
    );
    const unavailable = product.status !== "ACTIVE";
    const tracked = product.inventory.trackInventory;
    const insufficientStock = tracked && product.inventory.stockQuantity < line.quantity;

    return {
      productId: line.productId,
      name: product.name,
      sku: product.sku,
      imageUrl: imageUrls.get(line.productId) ?? null,
      quantity: line.quantity,
      unitPrice: product.pricing.sellingPrice,
      mrp: product.pricing.mrp,
      discount,
      discountPercentage,
      lineTotal: lineTotalFor(product.pricing.sellingPrice, line.quantity),
      unavailable,
      insufficientStock,
      // Meaningless for untracked products, reported as the requested
      // quantity so the frontend never renders a bogus "0 available".
      availableQuantity: tracked ? product.inventory.stockQuantity : line.quantity,
    };
  });

  // Flagged lines are excluded from the totals — showing a subtotal that
  // includes something the customer can't actually buy would be worse than
  // showing a smaller one next to the warning.
  const payable = items.filter((i) => !i.unavailable && !i.insufficientStock);
  const pricing = computeOrderTotals(payable.map((i) => i.lineTotal), shippingPolicy);

  return {
    items,
    pricing,
    hasIssues: items.some((i) => i.unavailable || i.insufficientStock),
  };
}

// ---- Stock reservation ----
// No Mongo transactions are available (standalone mongod, no replica set —
// the same constraint product.service.ts's createProduct documents), so the
// decrement is a per-line atomic conditional update plus a compensating
// rollback loop, not a transaction. The $gte guard inside the update filter
// is what makes it race-safe: two concurrent checkouts for the last unit
// can't both match.
interface ReservedLine {
  productId: string;
  quantity: number;
}

async function releaseReservations(reserved: ReservedLine[]): Promise<void> {
  for (const line of reserved) {
    try {
      await Product.updateOne(
        { _id: line.productId },
        { $inc: { "inventory.stockQuantity": line.quantity } }
      );
    } catch (err) {
      // A failed rollback must never mask the original error that triggered
      // it — the customer gets the real reason, and the discrepancy is
      // logged for reconciliation.
      console.error("Stock rollback failed", {
        productId: line.productId,
        quantity: line.quantity,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }
}

// ---- Checkout ----

export async function createCheckout(
  userId: string,
  input: CreateCheckoutInput,
  idempotencyKey: string
): Promise<{ order: ReturnType<typeof toOrderDto>; razorpayOrder: unknown; replayed: boolean }> {
  // Replay guard first, before touching stock: a double-submitted (or
  // retried-after-timeout) checkout with the same key returns the order that
  // already exists instead of charging and decrementing twice.
  const existing = await Order.findOne({ idempotencyKey }).exec();
  if (existing) {
    return {
      order: toOrderDto(existing),
      razorpayOrder: existing.payment?.razorpayOrderId
        ? { id: existing.payment.razorpayOrderId, amount: Math.round(existing.pricing.grandTotal * 100), currency: "INR" }
        : null,
      replayed: true,
    };
  }

  const address = await getAddressOrThrow(userId, input.addressId);

  const products = await loadProducts(input.items);
  const imageUrls = await getPrimaryImageUrlMap(input.items.map((i) => i.productId));
  const shippingPolicy = await getShippingPolicy();

  const reserved: ReservedLine[] = [];
  const orderItems: OrderItem[] = [];

  try {
    for (const line of input.items) {
      const product = products.get(line.productId);
      if (!product || product.status !== "ACTIVE") {
        throw new AppError(
          product ? `${product.name} is no longer available` : "One or more products are no longer available",
          409
        );
      }

      if (product.inventory.trackInventory) {
        // The read above is only for pricing/naming — this conditional
        // update is the actual reservation, and a null result means someone
        // else took the stock between the two (race lost, not a stale read).
        const claimed = await Product.findOneAndUpdate(
          { _id: line.productId, "inventory.stockQuantity": { $gte: line.quantity } },
          { $inc: { "inventory.stockQuantity": -line.quantity } }
        ).exec();
        if (!claimed) {
          throw new AppError(`Insufficient stock for ${product.name}`, 409);
        }
        reserved.push({ productId: line.productId, quantity: line.quantity });
      }

      const { discount, discountPercentage } = computeDiscount(
        product.pricing.mrp,
        product.pricing.sellingPrice
      );

      orderItems.push({
        productId: product._id,
        name: product.name,
        sku: product.sku,
        imageUrl: imageUrls.get(line.productId) ?? null,
        quantity: line.quantity,
        unitPrice: product.pricing.sellingPrice,
        mrp: product.pricing.mrp,
        discount,
        discountPercentage,
        lineTotal: lineTotalFor(product.pricing.sellingPrice, line.quantity),
      });
    }

    const pricing = computeOrderTotals(orderItems.map((i) => i.lineTotal), shippingPolicy);
    const status = input.paymentMethod === "COD" ? "CONFIRMED" : "PENDING_PAYMENT";

    let order: OrderDocument;
    try {
      order = await createOrderWithUniqueNumber({
        userId: new mongoose.Types.ObjectId(userId),
        items: orderItems,
        pricing,
        shippingAddress: {
          label: address.label,
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
        },
        status,
        paymentMethod: input.paymentMethod,
        paymentStatus: "PENDING",
        idempotencyKey,
        statusHistory: [{ status, at: new Date(), note: "Order placed" }],
      });
    } catch (err) {
      // Two requests racing on the same idempotency key: the loser hits the
      // unique index. Return the winner's order rather than erroring — that
      // IS the guarantee the key is supposed to provide.
      if (isDuplicateKeyError(err, "idempotencyKey")) {
        await releaseReservations(reserved);
        const winner = await Order.findOne({ idempotencyKey }).exec();
        if (winner) {
          return {
            order: toOrderDto(winner),
            razorpayOrder: winner.payment?.razorpayOrderId
              ? { id: winner.payment.razorpayOrderId, amount: Math.round(winner.pricing.grandTotal * 100), currency: "INR" }
              : null,
            replayed: true,
          };
        }
      }
      throw err;
    }

    let razorpayOrder: unknown = null;
    if (input.paymentMethod === "RAZORPAY") {
      try {
        razorpayOrder = await createRazorpayOrder(
          Math.round(pricing.grandTotal * 100),
          order.orderNumber
        );
        order.payment = { razorpayOrderId: (razorpayOrder as { id: string }).id };
        await order.save();
      } catch (err) {
        // The gateway call failed after the order row exists. Delete it and
        // release the stock rather than stranding an unpayable
        // PENDING_PAYMENT order that also burns the idempotency key.
        await order.deleteOne();
        throw err;
      }
    }

    return { order: toOrderDto(order), razorpayOrder, replayed: false };
  } catch (err) {
    await releaseReservations(reserved);
    throw err;
  }
}

function isDuplicateKeyError(err: unknown, field: string): boolean {
  const candidate = err as { code?: number; keyPattern?: Record<string, unknown> };
  return candidate?.code === 11000 && Boolean(candidate.keyPattern && field in candidate.keyPattern);
}
