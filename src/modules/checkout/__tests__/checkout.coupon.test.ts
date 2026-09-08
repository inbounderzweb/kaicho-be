import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order, Coupon, CouponUsage, ProductStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { computeOrderTotals } from "../checkout.service";
import { cancelStalePendingOrders } from "../../order/orderCleanup";
import { ensureCouponIndexes } from "../../coupon/coupon.indexes";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];
const createdCouponIds: mongoose.Types.ObjectId[] = [];
let couponSeq = 0;

async function makeUser() {
  const user = await User.create({
    phone: `75${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

async function makeProduct(options: { stock?: number; sellingPrice?: number; status?: ProductStatus } = {}) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `CheckoutCoupon Product ${RUN_ID}-${n}`,
    slug: `checkoutcoupon-product-${RUN_ID}-${n}`,
    sku: `CCO-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: (options.sellingPrice ?? 800) + 200, sellingPrice: options.sellingPrice ?? 800 },
    inventory: { stockQuantity: options.stock ?? 50, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["coupon"] },
    status: options.status ?? "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

async function makeCoupon(overrides: Record<string, unknown> = {}) {
  couponSeq += 1;
  const coupon = await Coupon.create({
    code: `CHK${RUN_ID}${couponSeq}`,
    name: "Checkout coupon",
    discountType: "PERCENTAGE",
    discountValue: 10,
    status: "ACTIVE",
    ...overrides,
  });
  createdCouponIds.push(coupon._id);
  return coupon;
}

async function makeAddress(user: InstanceType<typeof User>): Promise<string> {
  const res = await request(app)
    .post("/api/addresses")
    .set("Cookie", authCookie(user))
    .send({
      label: "Home",
      receiverName: "Asha Menon",
      receiverPhone: "9876543210",
      houseNo: "12",
      area: "Marine Drive",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400020",
    });
  return res.body.data.address.addressId;
}

function checkout(user: InstanceType<typeof User>, body: object, key = `k-${RUN_ID}-${Math.random().toString(36).slice(2)}`) {
  return request(app)
    .post("/api/checkout")
    .set("Cookie", authCookie(user))
    .set("Idempotency-Key", key)
    .send(body);
}

beforeAll(async () => {
  await connectDatabase();
  await ensureCouponIndexes();
});

afterAll(async () => {
  await CouponUsage.deleteMany({ couponId: { $in: createdCouponIds } });
  await Coupon.deleteMany({ _id: { $in: createdCouponIds } });
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("computeOrderTotals with a resolved discount", () => {
  it("subtracts the discount from the grand total", () => {
    const totals = computeOrderTotals([1000], undefined, { discountAmount: 100, freeDelivery: false });
    expect(totals.subtotal).toBe(1000);
    expect(totals.discountTotal).toBe(100);
    expect(totals.grandTotal).toBe(900); // 1000 - 100, shipping already free at >= 499
  });

  it("free delivery zeroes the shipping fee without touching the subtotal", () => {
    const totals = computeOrderTotals([300], undefined, { discountAmount: 0, freeDelivery: true });
    expect(totals.subtotal).toBe(300);
    expect(totals.discountTotal).toBe(0);
    expect(totals.shippingFee).toBe(0);
    expect(totals.grandTotal).toBe(300);
  });

  it("is unchanged when no discount is passed (back-compat)", () => {
    const totals = computeOrderTotals([100, 50]);
    expect(totals).toMatchObject({ subtotal: 150, discountTotal: 0 });
  });
});

describe("Checkout with a coupon (COD)", () => {
  it("persists the discount, the coupon snapshot and a usage row", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800, stock: 20 });
    const addressId = await makeAddress(user);
    const coupon = await makeCoupon({ discountType: "PERCENTAGE", discountValue: 10, usageLimit: 5 });

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 2 }], // subtotal 1600
      addressId,
      paymentMethod: "COD",
      couponCode: coupon.code.toLowerCase(),
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.pricing.subtotal).toBe(1600);
    expect(res.body.data.order.pricing.discountTotal).toBe(160);
    expect(res.body.data.order.pricing.grandTotal).toBe(1440);
    expect(res.body.data.order.coupon).toEqual({
      code: coupon.code,
      discountType: "PERCENTAGE",
      discountAmount: 160,
      freeDelivery: false,
    });

    const freshCoupon = await Coupon.findById(coupon._id).lean();
    expect(freshCoupon!.usedCount).toBe(1);

    const usage = await CouponUsage.findOne({ couponId: coupon._id }).lean();
    expect(usage).toBeTruthy();
    expect(usage!.orderNumber).toBe(res.body.data.order.orderNumber);
    expect(usage!.discountAmount).toBe(160);
    expect(usage!.perUserSeq).toBe(1);
  });

  it("free-delivery coupon zeroes shipping on a small order", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 300, stock: 20 });
    const addressId = await makeAddress(user);
    const coupon = await makeCoupon({ discountType: "FREE_DELIVERY", discountValue: 0 });

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 1 }], // subtotal 300, normally +49 shipping
      addressId,
      paymentMethod: "COD",
      couponCode: coupon.code,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.pricing.shippingFee).toBe(0);
    expect(res.body.data.order.pricing.discountTotal).toBe(0);
    expect(res.body.data.order.pricing.grandTotal).toBe(300);
    expect(res.body.data.order.coupon.freeDelivery).toBe(true);
  });

  it("409s and places no order when the coupon is expired at checkout time", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800, stock: 20 });
    const addressId = await makeAddress(user);
    const coupon = await makeCoupon({ expiresAt: new Date(Date.now() - 60_000) });

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 1 }],
      addressId,
      paymentMethod: "COD",
      couponCode: coupon.code,
    });

    expect(res.status).toBe(400);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    // Stock reserved during the attempt must be released.
    const fresh = await Product.findById(product._id).lean();
    expect(fresh!.inventory.stockQuantity).toBe(20);
  });
});

describe("Coupon release on order cancellation", () => {
  it("cancelling a COD order frees the coupon slot and usage row", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800, stock: 20 });
    const addressId = await makeAddress(user);
    const coupon = await makeCoupon({ discountValue: 10, usageLimit: 3 });

    const placed = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 1 }],
      addressId,
      paymentMethod: "COD",
      couponCode: coupon.code,
    });
    expect(placed.status).toBe(201);
    expect((await Coupon.findById(coupon._id).lean())!.usedCount).toBe(1);

    const orderNumber = placed.body.data.order.orderNumber;
    const cancelled = await request(app)
      .post(`/api/orders/${encodeURIComponent(orderNumber)}/cancel`)
      .set("Cookie", authCookie(user))
      .send({ reason: "changed my mind" });
    expect(cancelled.status).toBe(200);

    expect((await Coupon.findById(coupon._id).lean())!.usedCount).toBe(0);
    expect(await CouponUsage.countDocuments({ couponId: coupon._id })).toBe(0);
  });

  it("the stale-pending-order sweep releases the coupon", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800, stock: 20 });
    const coupon = await makeCoupon({ discountValue: 10, usageLimit: 3 });

    // Build a PENDING_PAYMENT order directly, backdated past the TTL, with a
    // consumed coupon — the shape createCheckout leaves for an abandoned
    // Razorpay payment.
    const order = await Order.create({
      orderNumber: `ORD-STALE-${RUN_ID}-${couponSeq}`,
      userId: user._id,
      items: [
        {
          productId: product._id,
          name: product.name,
          sku: product.sku,
          imageUrl: null,
          quantity: 1,
          unitPrice: 800,
          mrp: 1000,
          discount: 200,
          discountPercentage: 20,
          lineTotal: 800,
        },
      ],
      pricing: { subtotal: 800, discountTotal: 80, shippingFee: 0, taxTotal: 0, grandTotal: 720 },
      shippingAddress: { city: "Mumbai", state: "Maharashtra", pincode: "400020", line1: "12" },
      status: "PENDING_PAYMENT",
      paymentMethod: "RAZORPAY",
      paymentStatus: "PENDING",
      coupon: {
        couponId: coupon._id,
        code: coupon.code,
        discountType: "PERCENTAGE",
        discountAmount: 80,
        freeDelivery: false,
      },
      statusHistory: [{ status: "PENDING_PAYMENT", at: new Date(), note: "Order placed" }],
    });
    // Raw driver write — Mongoose's timestamps plugin strips a manual
    // createdAt from an updateOne.
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } }
    );

    await Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: 1 } });
    await CouponUsage.create({
      couponId: coupon._id,
      couponCode: coupon.code,
      userId: user._id,
      orderId: order._id,
      orderNumber: order.orderNumber,
      discountType: "PERCENTAGE",
      discountAmount: 80,
      freeDelivery: false,
      perUserSeq: 1,
      usedAt: new Date(),
    });

    await cancelStalePendingOrders();

    expect((await Order.findById(order._id).lean())!.status).toBe("CANCELLED");
    expect((await Coupon.findById(coupon._id).lean())!.usedCount).toBe(0);
    expect(await CouponUsage.countDocuments({ orderId: order._id })).toBe(0);
  });
});

describe("Checkout preview with a coupon", () => {
  it("returns the discounted pricing and the coupon summary", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800, stock: 20 });
    const coupon = await makeCoupon({ discountValue: 10 });

    const res = await request(app)
      .post("/api/checkout/preview")
      .set("Cookie", authCookie(user))
      .send({ items: [{ productId: product._id.toString(), quantity: 2 }], couponCode: coupon.code });

    expect(res.status).toBe(200);
    expect(res.body.data.couponError).toBeNull();
    expect(res.body.data.coupon).toMatchObject({ code: coupon.code, discountType: "PERCENTAGE" });
    expect(res.body.data.pricing.discountTotal).toBe(160);
    expect(res.body.data.pricing.grandTotal).toBe(1440);
  });

  it("prices the cart without a discount and reports couponError for a bad code", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800, stock: 20 });

    const res = await request(app)
      .post("/api/checkout/preview")
      .set("Cookie", authCookie(user))
      .send({ items: [{ productId: product._id.toString(), quantity: 2 }], couponCode: "NOT-A-REAL-CODE" });

    expect(res.status).toBe(200);
    expect(res.body.data.coupon).toBeNull();
    expect(res.body.data.couponError).toMatch(/isn't valid/i);
    expect(res.body.data.pricing.discountTotal).toBe(0);
    expect(res.body.data.pricing.grandTotal).toBe(1600);
  });
});
