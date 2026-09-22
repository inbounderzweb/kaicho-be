import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import {
  Product,
  Category,
  Order,
  OrderDocument,
  OrderItem,
  OrderPackLine,
  OrderInventoryComponentLine,
  ProductPackConfig,
  PackConfig,
  PackRecommendationStrategy,
  InventoryTracking,
  User,
  CouponDiscountType,
} from "../../database/models";
import { computeDiscount, getPrimaryImageUrlMap } from "../product/product.service";
import { resolveEffectivePackConfig } from "../product/packCombination.service";
import {
  resolveEffectiveComponents,
  calculateInventoryRequirement,
  validateInventoryAvailability,
  calculateMaximumAvailableQuantity,
  mergeResolvedComponents,
  type ResolvedComponent,
} from "../product/inventoryTracking.service";
import { getAddressOrThrow } from "../address/address.service";
import { createOrderWithUniqueNumber, toGa4PurchaseParams, toOrderDto } from "../order/order.service";
import {
  evaluateCouponForSubtotal,
  consumeCouponForOrder,
  releaseCouponForOrder,
  type EvaluatedCoupon,
} from "../coupon/coupon.service";
import { createRazorpayOrder } from "../../common/payments/razorpay";
import { getShippingPolicy, getDefaultPackRecommendationStrategy } from "../settings/settings.service";
import { notifyAdminsNewOrder } from "../notification/notification.service";
import { trackServerPurchase } from "../../common/analytics/ga4";
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

// A coupon discount already resolved to a concrete rupee amount by
// coupon.service — computeOrderTotals only subtracts it, it never re-derives
// it from the coupon rule (that lives in exactly one place).
export interface ResolvedDiscount {
  /** Rupees to take off the subtotal. 0 for a free-delivery coupon. */
  discountAmount: number;
  /** Force shippingFee to 0 regardless of the free-shipping threshold. */
  freeDelivery: boolean;
}

// The ONE place order money is totalled, for both preview and real checkout.
// taxTotal is 0 today: sellingPrice is treated as tax-inclusive (typical for
// Indian D2C listings) and no tax engine is configured — when GST breakout is
// needed it grows here and every caller inherits it for free.
export function computeOrderTotals(
  lineTotals: number[],
  policy: ShippingPolicy = DEFAULT_SHIPPING_POLICY,
  discount: ResolvedDiscount | null = null
): {
  subtotal: number;
  discountTotal: number;
  shippingFee: number;
  taxTotal: number;
  grandTotal: number;
} {
  // Summed in integer paise, then converted back once — the same
  // integer-minor-units rule computeDiscount() follows, so a cart of
  // fractional-rupee lines can't drift a paisa per line.
  const subtotalMinor = lineTotals.reduce((sum, value) => sum + Math.round(value * 100), 0);
  const subtotal = subtotalMinor / 100;

  // Clamped to [0, subtotal] here as a last guard; coupon.service already
  // computes it within those bounds.
  const discountMinor = discount
    ? Math.min(Math.max(0, Math.round(discount.discountAmount * 100)), subtotalMinor)
    : 0;

  // The free-shipping threshold is checked against the PRE-discount subtotal
  // on purpose: a coupon must never silently re-add a delivery fee by pushing
  // the order below the threshold.
  const shippingFeeBeforeCoupon = subtotal >= policy.freeShippingThreshold ? 0 : policy.flatShippingFee;
  const shippingFee = discount?.freeDelivery ? 0 : shippingFeeBeforeCoupon;

  const taxTotal = 0;
  const grandTotal =
    Math.max(
      0,
      subtotalMinor - discountMinor + Math.round(shippingFee * 100) + Math.round(taxTotal * 100)
    ) / 100;

  return { subtotal, discountTotal: discountMinor / 100, shippingFee, taxTotal, grandTotal };
}

function lineTotalFor(unitPrice: number, quantity: number): number {
  return (Math.round(unitPrice * 100) * quantity) / 100;
}

export interface RequestedLine {
  productId: string;
  quantity: number;
  // Optional pack combination the customer confirmed client-side (via
  // /cart/validate-pack or /cart/apply-pack) — a hint only. Everything
  // billable is re-derived from the product/category's LIVE pack config
  // below, exactly like `quantity`/price already are for plain unit lines.
  packSelection?: { packId: string; count: number }[];
}

export type PricedProduct = {
  _id: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  status: string;
  categoryId: mongoose.Types.ObjectId;
  pricing: { mrp: number; sellingPrice: number };
  inventory: { stockQuantity: number; trackInventory: boolean };
  packConfig?: ProductPackConfig;
  inventoryTracking?: InventoryTracking;
};

async function loadProducts(items: RequestedLine[]): Promise<Map<string, PricedProduct>> {
  const docs = await Product.find({ _id: { $in: items.map((i) => i.productId) } })
    .select("name sku status categoryId pricing inventory packConfig inventoryTracking")
    .lean();
  return new Map(docs.map((d) => [d._id.toString(), d as unknown as PricedProduct]));
}

export interface ComponentStock {
  name: string;
  sku: string;
  stockQuantity: number;
  trackInventory: boolean;
}

// Inventory components can reference a product that's nowhere else in the
// cart (e.g. a combo pulling from a product the customer never directly
// added) — this batch-loads whichever of those aren't already covered by
// `loadProducts`'s result. Callers pass the union of ids they still need;
// already-known productIds are cheap to re-request (a no-op $in match) and
// keeping this a single extra query is simpler than diffing.
async function loadComponentStock(productIds: string[]): Promise<Map<string, ComponentStock>> {
  if (productIds.length === 0) return new Map();
  const docs = await Product.find({ _id: { $in: productIds } })
    .select("name sku inventory")
    .lean();
  return new Map(
    docs.map((d) => [
      d._id.toString(),
      {
        name: d.name,
        sku: d.sku,
        stockQuantity: d.inventory.stockQuantity,
        trackInventory: d.inventory.trackInventory,
      },
    ])
  );
}

// Only fetched for lines that actually carry a packSelection — the vast
// majority of checkouts today are plain unit lines and shouldn't pay for an
// extra query. Batched by distinct categoryId, not once per line.
async function loadCategoryPackConfigs(
  categoryIds: mongoose.Types.ObjectId[]
): Promise<Map<string, { packConfig?: PackConfig }>> {
  if (categoryIds.length === 0) return new Map();
  const docs = await Category.find({ _id: { $in: categoryIds } })
    .select("packConfig")
    .lean();
  return new Map(docs.map((d) => [d._id.toString(), d as unknown as { packConfig?: PackConfig }]));
}

export interface ResolvedLine {
  /** Total base units — for a PACK line this is packQuantity*packCount summed, never a "pack count". */
  quantity: number;
  lineTotal: number;
  /** Blended per-unit price (lineTotal / quantity) — kept for OrderItem.unitPrice's existing per-unit semantics. */
  unitPrice: number;
  discount: number;
  discountPercentage: number;
  selectionType: "UNIT" | "PACK";
  packBreakdown?: OrderPackLine[];
  /** Already multiplied by however many units/packs this line purchased — ready to merge across lines and deduct. */
  inventoryRequirement: ResolvedComponent[];
  /** True only when this line's requirement came from an explicit product/pack component configuration, not the self-referencing fallback — gates whether OrderItem.inventoryComponents gets populated (see inventoryTracking.service.ts#resolveEffectiveComponents). */
  usesComponentTracking: boolean;
}

// Authoritatively resolves ONE cart line to a billable quantity/price.
// Plain unit lines behave exactly as before this feature existed. A line
// carrying `packSelection` is validated against the product's LIVE effective
// pack config (Product > Category, never the client's cached copy) — an
// unknown/inactive packId, a disallowed mix, or a product with packs not
// enabled at all throws, forcing the client to re-derive its selection
// rather than silently falling back (spec §7/§23: never trust a
// client-calculated price).
// Exported so cartPack.service.ts (the public /cart/validate-pack and
// /cart/apply-pack endpoints) can reuse the exact same authoritative
// resolution logic rather than re-implementing it — one place decides what a
// pack selection actually costs and how many base units it represents.
export function resolveLine(
  line: RequestedLine,
  product: PricedProduct,
  category: { packConfig?: PackConfig } | null,
  defaultStrategy: PackRecommendationStrategy
): ResolvedLine {
  if (!line.packSelection || line.packSelection.length === 0) {
    const unitPrice = product.pricing.sellingPrice;
    const { discount, discountPercentage } = computeDiscount(product.pricing.mrp, unitPrice);
    const perUnitComponents = resolveEffectiveComponents(product);
    return {
      quantity: line.quantity,
      lineTotal: lineTotalFor(unitPrice, line.quantity),
      unitPrice,
      discount,
      discountPercentage,
      selectionType: "UNIT",
      inventoryRequirement: calculateInventoryRequirement(perUnitComponents, line.quantity),
      usesComponentTracking: Boolean(
        product.inventoryTracking?.enabled && product.inventoryTracking.components.length > 0
      ),
    };
  }

  const effective = resolveEffectivePackConfig(product, category, defaultStrategy);
  if (!effective) {
    throw new AppError(`${product.name} does not support pack selections`, 400);
  }

  if (!effective.mixedPacksAllowed) {
    const distinctPackIds = new Set(line.packSelection.map((s) => s.packId));
    if (distinctPackIds.size > 1) {
      throw new AppError(`${product.name} does not allow mixing pack sizes`, 400);
    }
  }

  const activePacksById = new Map(effective.packs.filter((p) => p.isActive).map((p) => [p._id.toString(), p]));

  let totalQuantity = 0;
  let totalPriceMinor = 0;
  const packBreakdown: OrderPackLine[] = [];
  // Different packs within the same (mixed) selection can each have their
  // own component override — resolved and merged per selection, not once
  // for the whole line, so a 20-pack with its own components and a 10-pack
  // that falls back to its parent both contribute correctly.
  const requirementsPerSelection: ResolvedComponent[][] = [];
  let usesComponentTracking = false;
  for (const selection of line.packSelection) {
    const pack = activePacksById.get(selection.packId);
    if (!pack) {
      throw new AppError(`A selected pack for ${product.name} is no longer available`, 409);
    }
    totalQuantity += pack.quantity * selection.count;
    totalPriceMinor += Math.round(pack.price * 100) * selection.count;
    packBreakdown.push({
      packId: pack._id,
      packName: pack.name,
      packQuantity: pack.quantity,
      packCount: selection.count,
      packPrice: pack.price,
    });

    const packComponents = resolveEffectiveComponents(product, pack);
    requirementsPerSelection.push(calculateInventoryRequirement(packComponents, selection.count));
    if (pack.useComponentInventory && pack.inventoryComponents.length > 0) {
      usesComponentTracking = true;
    }
  }

  const lineTotal = totalPriceMinor / 100;
  const unitPrice = totalQuantity > 0 ? Math.round((lineTotal / totalQuantity) * 100) / 100 : 0;
  const { discount, discountPercentage } = computeDiscount(product.pricing.mrp, unitPrice);

  return {
    quantity: totalQuantity,
    lineTotal,
    unitPrice,
    discount,
    discountPercentage,
    selectionType: "PACK",
    packBreakdown,
    inventoryRequirement: mergeResolvedComponents(...requirementsPerSelection),
    usesComponentTracking,
  };
}

// ---- Preview ----
// Pure read/compute — never mutates stock. Its job is to tell the checkout UI
// what the server actually believes about every line (current price, current
// availability) BEFORE the customer commits, so "price changed since you
// added this" / "only 2 left" can be shown instead of a surprise 409 at
// submit time. Unavailable lines are flagged, not thrown on, for exactly
// that reason.
export async function previewCheckout(userId: string, input: CheckoutPreviewInput) {
  const products = await loadProducts(input.items);
  const imageUrls = await getPrimaryImageUrlMap(input.items.map((i) => i.productId));
  const [shippingPolicy, defaultStrategy, categories] = await Promise.all([
    getShippingPolicy(),
    getDefaultPackRecommendationStrategy(),
    loadCategoryPackConfigs(
      [...products.values()].filter((p) => input.items.some((i) => i.productId === p._id.toString() && i.packSelection)).map((p) => p.categoryId)
    ),
  ]);

  // Pass 1: resolve every line's pricing + inventory requirement. Errors
  // (stale pack selection etc.) are captured per-line, not thrown — preview
  // must still render a row for every line so the UI can prompt a fix on
  // just that one.
  const resolvedLines = input.items.map((line) => {
    const product = products.get(line.productId);
    if (!product) return { line, product: null, resolved: null, error: null as string | null };

    try {
      const resolved = resolveLine(line, product, categories.get(product.categoryId.toString()) ?? null, defaultStrategy);
      return { line, product, resolved, error: null as string | null };
    } catch (err) {
      return {
        line,
        product,
        resolved: null,
        error: err instanceof AppError ? err.message : "This pack selection is no longer available.",
      };
    }
  });

  // Pass 2: aggregate every successfully-resolved line's requirement across
  // the WHOLE cart, so a component two different lines both need is checked
  // against its real combined demand — not twice independently, which could
  // pass each line individually while together exceeding stock.
  const combinedRequirement = mergeResolvedComponents(
    ...resolvedLines.filter((r) => r.resolved).map((r) => r.resolved!.inventoryRequirement)
  );
  const knownComponentIds = new Set(combinedRequirement.map((c) => c.productId));
  const extraComponentIds = [...knownComponentIds].filter((id) => !products.has(id));
  const componentStock = await loadComponentStock(extraComponentIds);
  const stockByProductId = new Map<string, ComponentStock>([
    ...[...products.entries()].map(([id, p]) => [id, { name: p.name, sku: p.sku, ...p.inventory }] as const),
    ...componentStock.entries(),
  ]);
  const { shortfalls } = validateInventoryAvailability(combinedRequirement, 1, stockByProductId);
  const shortfallSet = new Set(shortfalls);

  // Pass 3: shape the response DTO, now that both the resolution and the
  // cross-line availability check are done.
  const items = resolvedLines.map(({ line, product, resolved, error }) => {
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
        selectionType: "UNIT" as const,
        packBreakdown: undefined as ResolvedLine["packBreakdown"],
        unavailable: true,
        insufficientStock: false,
        availableQuantity: 0,
      };
    }

    if (!resolved) {
      return {
        productId: line.productId,
        name: product.name,
        sku: product.sku,
        imageUrl: imageUrls.get(line.productId) ?? null,
        quantity: line.quantity,
        unitPrice: 0,
        mrp: product.pricing.mrp,
        discount: 0,
        discountPercentage: 0,
        lineTotal: 0,
        selectionType: "UNIT" as const,
        packBreakdown: undefined as ResolvedLine["packBreakdown"],
        unavailable: true,
        insufficientStock: false,
        availableQuantity: product.inventory.trackInventory ? product.inventory.stockQuantity : line.quantity,
        packError: error,
      };
    }

    const unavailable = product.status !== "ACTIVE";
    const insufficientStock = resolved.inventoryRequirement.some((r) => shortfallSet.has(r.productId));

    // Informational only — the exact max-purchasable figure is only
    // well-defined for a UNIT line (one product, one component set); a
    // mixed PACK line's "how many more could I add" doesn't reduce to one
    // number the same way, so it falls back to the parent's own raw stock,
    // same as before this feature existed.
    const componentMax =
      resolved.selectionType === "UNIT" && resolved.usesComponentTracking
        ? calculateMaximumAvailableQuantity(resolveEffectiveComponents(product), stockByProductId)
        : null;
    // Infinity means every component is untracked — same "nothing to cap
    // against" case as an untracked plain product, reported as the
    // requested quantity so the frontend never renders a bogus number.
    const availableQuantity =
      componentMax !== null
        ? componentMax === Infinity
          ? resolved.quantity
          : componentMax
        : product.inventory.trackInventory
          ? product.inventory.stockQuantity
          : resolved.quantity;

    return {
      productId: line.productId,
      name: product.name,
      sku: product.sku,
      imageUrl: imageUrls.get(line.productId) ?? null,
      quantity: resolved.quantity,
      unitPrice: resolved.unitPrice,
      mrp: product.pricing.mrp,
      discount: resolved.discount,
      discountPercentage: resolved.discountPercentage,
      lineTotal: resolved.lineTotal,
      selectionType: resolved.selectionType,
      packBreakdown: resolved.packBreakdown,
      unavailable,
      insufficientStock,
      availableQuantity,
    };
  });

  // Flagged lines are excluded from the totals — showing a subtotal that
  // includes something the customer can't actually buy would be worse than
  // showing a smaller one next to the warning.
  const payable = items.filter((i) => !i.unavailable && !i.insufficientStock);
  const eligibleSubtotal =
    payable.reduce((sum, i) => sum + Math.round(i.lineTotal * 100), 0) / 100;

  let coupon:
    | {
        code: string;
        name: string;
        discountType: CouponDiscountType;
        discountAmount: number;
        freeDelivery: boolean;
      }
    | null = null;
  let couponError: string | null = null;
  let resolvedDiscount: ResolvedDiscount | null = null;

  if (input.couponCode) {
    try {
      const evaluated = await evaluateCouponForSubtotal({
        code: input.couponCode,
        userId,
        subtotal: eligibleSubtotal,
      });
      coupon = {
        code: evaluated.code,
        name: evaluated.name,
        discountType: evaluated.discountType,
        discountAmount: evaluated.discountAmount,
        freeDelivery: evaluated.freeDelivery,
      };
      resolvedDiscount = {
        discountAmount: evaluated.discountAmount,
        freeDelivery: evaluated.freeDelivery,
      };
    } catch (err) {
      // Preview must still price the cart when the coupon is bad — the page
      // needs a total to render. The reason is surfaced, not thrown.
      couponError = err instanceof AppError ? err.message : "Couldn't apply this coupon.";
    }
  }

  const pricing = computeOrderTotals(payable.map((i) => i.lineTotal), shippingPolicy, resolvedDiscount);

  return {
    items,
    pricing,
    coupon,
    couponError,
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

  // A reachable mobile number is mandatory to place an order — deliveries and
  // order updates depend on it. Google-sign-in accounts start without one;
  // the checkout page makes them add it first, and this is the enforcement.
  const buyer = await User.findById(userId).select("phone").lean();
  if (!buyer?.phone) {
    throw new AppError("Add a mobile number to your account before checking out.", 400);
  }

  const address = await getAddressOrThrow(userId, input.addressId);

  const products = await loadProducts(input.items);
  const imageUrls = await getPrimaryImageUrlMap(input.items.map((i) => i.productId));
  const [shippingPolicy, defaultStrategy, categories] = await Promise.all([
    getShippingPolicy(),
    getDefaultPackRecommendationStrategy(),
    loadCategoryPackConfigs(
      [...products.values()].filter((p) => input.items.some((i) => i.productId === p._id.toString() && i.packSelection)).map((p) => p.categoryId)
    ),
  ]);

  const reserved: ReservedLine[] = [];
  const orderItems: OrderItem[] = [];

  try {
    // Pass 1: resolve every line's pricing + inventory requirement first —
    // no reservation yet. Throws immediately on a vanished/inactive product
    // or an invalid pack selection, same as before this feature existed.
    const resolvedLines = input.items.map((line) => {
      const product = products.get(line.productId);
      if (!product || product.status !== "ACTIVE") {
        throw new AppError(
          product ? `${product.name} is no longer available` : "One or more products are no longer available",
          409
        );
      }
      const resolved = resolveLine(line, product, categories.get(product.categoryId.toString()) ?? null, defaultStrategy);
      return { line, product, resolved };
    });

    // Pass 2: aggregate every line's requirement into one combined demand
    // per component product — this is what makes two lines/packs sharing a
    // component (e.g. Navadhanya sold both loose and inside a combo in the
    // same order) reserve against their true combined total rather than
    // racing two independent checks against the same stock (spec §17).
    const combinedRequirement = mergeResolvedComponents(...resolvedLines.map((r) => r.resolved.inventoryRequirement));
    const knownComponentIds = new Set(combinedRequirement.map((c) => c.productId));
    const extraComponentIds = [...knownComponentIds].filter((id) => !products.has(id));
    const componentStock = await loadComponentStock(extraComponentIds);
    const stockByProductId = new Map<string, ComponentStock>([
      ...[...products.entries()].map(([id, p]) => [id, { name: p.name, sku: p.sku, ...p.inventory }] as const),
      ...componentStock.entries(),
    ]);

    // Pass 3: reserve each distinct component exactly once, for its
    // combined total — same atomic $gte-guarded decrement as before this
    // feature existed (no DB transactions available; see this file's
    // header comment on `ReservedLine`), just keyed by component productId
    // instead of by cart-line productId. A null result (lost the race, or a
    // component that's disappeared) throws, and the outer catch releases
    // everything already reserved — no partial deduction survives (spec §17).
    for (const requirement of combinedRequirement) {
      const stock = stockByProductId.get(requirement.productId);
      if (!stock) {
        // The component product itself no longer exists — never silently
        // skip a required component, that would ship an order with pieces
        // missing.
        throw new AppError("One or more required products are no longer available", 409);
      }
      if (!stock.trackInventory) continue;
      const claimed = await Product.findOneAndUpdate(
        { _id: requirement.productId, "inventory.stockQuantity": { $gte: requirement.quantity } },
        { $inc: { "inventory.stockQuantity": -requirement.quantity } }
      ).exec();
      if (!claimed) {
        throw new AppError(`Insufficient stock for ${stock.name}`, 409);
      }
      reserved.push({ productId: requirement.productId, quantity: requirement.quantity });
    }

    // Pass 4: build the order line items, now that reservation succeeded.
    for (const { line, product, resolved } of resolvedLines) {
      const inventoryComponents: OrderInventoryComponentLine[] | undefined = resolved.usesComponentTracking
        ? resolved.inventoryRequirement.map((r) => {
            const stock = stockByProductId.get(r.productId);
            return {
              productId: new mongoose.Types.ObjectId(r.productId),
              productName: stock?.name ?? "",
              productSku: stock?.sku ?? "",
              quantity: r.quantity,
            };
          })
        : undefined;

      orderItems.push({
        productId: product._id,
        name: product.name,
        sku: product.sku,
        imageUrl: imageUrls.get(line.productId) ?? null,
        quantity: resolved.quantity,
        unitPrice: resolved.unitPrice,
        mrp: product.pricing.mrp,
        discount: resolved.discount,
        discountPercentage: resolved.discountPercentage,
        lineTotal: resolved.lineTotal,
        selectionType: resolved.selectionType,
        packBreakdown: resolved.packBreakdown,
        inventoryComponents,
      });
    }

    // Re-validate the coupon against the freshly-priced cart, at this instant
    // — the preview the customer saw may be minutes old and the coupon could
    // have expired or hit its limit since (spec §10). Throwing here aborts
    // the checkout; the outer catch releases the stock just reserved. Usage
    // is NOT consumed yet — that's the atomic step after the order row
    // exists.
    let appliedCoupon: EvaluatedCoupon | null = null;
    if (input.couponCode) {
      const eligibleSubtotal =
        orderItems.reduce((sum, i) => sum + Math.round(i.lineTotal * 100), 0) / 100;
      appliedCoupon = await evaluateCouponForSubtotal({
        code: input.couponCode,
        userId,
        subtotal: eligibleSubtotal,
      });
    }

    const pricing = computeOrderTotals(
      orderItems.map((i) => i.lineTotal),
      shippingPolicy,
      appliedCoupon
        ? { discountAmount: appliedCoupon.discountAmount, freeDelivery: appliedCoupon.freeDelivery }
        : null
    );
    const status = input.paymentMethod === "COD" ? "CONFIRMED" : "PENDING_PAYMENT";

    let order: OrderDocument;
    try {
      order = await createOrderWithUniqueNumber({
        userId: new mongoose.Types.ObjectId(userId),
        items: orderItems,
        pricing,
        coupon: appliedCoupon
          ? {
              couponId: new mongoose.Types.ObjectId(appliedCoupon.couponId),
              code: appliedCoupon.code,
              discountType: appliedCoupon.discountType,
              discountAmount: appliedCoupon.discountAmount,
              freeDelivery: appliedCoupon.freeDelivery,
            }
          : undefined,
        shippingAddress: {
          label: address.label,
          receiverName: address.receiverName,
          receiverPhone: address.receiverPhone,
          houseNo: address.houseNo,
          building: address.building,
          area: address.area,
          landmark: address.landmark,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
          line1: address.line1,
          line2: address.line2,
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

    // Consume the coupon now that the order row exists (it needs the orderId).
    // Race-safe atomic increment + usage row; see coupon.service. On failure
    // the coupon slot is gone — undo the whole order, then let the outer
    // catch release the reserved stock.
    if (appliedCoupon) {
      try {
        await consumeCouponForOrder({
          code: appliedCoupon.code,
          userId,
          order,
          discount: {
            discountType: appliedCoupon.discountType,
            discountAmount: appliedCoupon.discountAmount,
            freeDelivery: appliedCoupon.freeDelivery,
          },
        });
      } catch (err) {
        await order.deleteOne();
        throw err;
      }
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
        // release the stock (and any consumed coupon) rather than stranding
        // an unpayable PENDING_PAYMENT order that also burns the idempotency
        // key.
        await order.deleteOne();
        await releaseCouponForOrder(order);
        throw err;
      }
    }

    // COD orders are CONFIRMED the instant they're placed (no separate
    // payment-success step) — that's the "successfully placed" moment for
    // this payment method, so the admin notification and GA4 purchase event
    // both fire right here. RAZORPAY orders stay PENDING_PAYMENT until
    // payment.service.ts confirms them, which is where the equivalent calls
    // live for that path.
    if (order.status === "CONFIRMED") {
      notifyAdminsNewOrder(order).catch((err) => {
        console.error("[notification] new-order notify failed", err);
      });
      trackServerPurchase(toGa4PurchaseParams(order)).catch((err) => {
        console.error("[analytics] GA4 purchase tracking failed", err);
      });
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

// ---- Coupon validation (POST /api/coupons/validate) ----
// Prices the cart the same way previewCheckout does — only ACTIVE, in-stock
// lines count toward the eligible subtotal — then runs the full coupon rule
// set. Unlike preview, an invalid coupon THROWS here: answering "can I use
// this code" IS this endpoint's job, so the AppError is the answer. Never
// consumes usage (spec §9).
export async function validateCouponForCart(
  userId: string,
  code: string,
  items: RequestedLine[]
) {
  const products = await loadProducts(items);
  const [shippingPolicy, defaultStrategy, categories] = await Promise.all([
    getShippingPolicy(),
    getDefaultPackRecommendationStrategy(),
    loadCategoryPackConfigs(
      [...products.values()].filter((p) => items.some((i) => i.productId === p._id.toString() && i.packSelection)).map((p) => p.categoryId)
    ),
  ]);

  const resolvedForEligibility: { resolved: ResolvedLine }[] = [];
  for (const line of items) {
    const product = products.get(line.productId);
    if (!product || product.status !== "ACTIVE") continue;
    try {
      resolvedForEligibility.push({ resolved: resolveLine(line, product, categories.get(product.categoryId.toString()) ?? null, defaultStrategy) });
    } catch {
      continue;
    }
  }

  // Same cross-line aggregate check previewCheckout uses — a component two
  // lines share must be checked against their combined demand, not each
  // line independently.
  const combinedRequirement = mergeResolvedComponents(...resolvedForEligibility.map((r) => r.resolved.inventoryRequirement));
  const knownComponentIds = new Set(combinedRequirement.map((c) => c.productId));
  const extraComponentIds = [...knownComponentIds].filter((id) => !products.has(id));
  const componentStock = await loadComponentStock(extraComponentIds);
  const stockByProductId = new Map<string, ComponentStock>([
    ...[...products.entries()].map(([id, p]) => [id, { name: p.name, sku: p.sku, ...p.inventory }] as const),
    ...componentStock.entries(),
  ]);
  const { shortfalls } = validateInventoryAvailability(combinedRequirement, 1, stockByProductId);
  const shortfallSet = new Set(shortfalls);

  const eligibleLineTotals = resolvedForEligibility
    .filter(({ resolved }) => !resolved.inventoryRequirement.some((r) => shortfallSet.has(r.productId)))
    .map(({ resolved }) => resolved.lineTotal);

  const subtotal = eligibleLineTotals.reduce((sum, v) => sum + Math.round(v * 100), 0) / 100;

  const evaluated = await evaluateCouponForSubtotal({ code, userId, subtotal });
  const pricing = computeOrderTotals(eligibleLineTotals, shippingPolicy, {
    discountAmount: evaluated.discountAmount,
    freeDelivery: evaluated.freeDelivery,
  });

  return {
    valid: true as const,
    coupon: { code: evaluated.code, name: evaluated.name },
    discount: {
      type: evaluated.discountType,
      amount: evaluated.discountAmount,
      freeDelivery: evaluated.freeDelivery,
    },
    pricing: {
      subtotal: pricing.subtotal,
      discount: pricing.discountTotal,
      delivery: pricing.shippingFee,
      total: pricing.grandTotal,
    },
  };
}
