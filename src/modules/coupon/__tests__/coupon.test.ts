import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import {
  User,
  Product,
  Order,
  Coupon,
  CouponUsage,
  ProductStatus,
  CouponDiscountType,
  CouponStatus,
} from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureCouponIndexes } from "../coupon.indexes";
import {
  canonicalizeCouponCode,
  getEffectiveCouponStatus,
  computeCouponDiscount,
} from "../coupon.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];
const createdCouponIds: mongoose.Types.ObjectId[] = [];

let couponSeq = 0;

async function makeUser() {
  const user = await User.create({
    phone: `74${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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
    name: `Coupon Product ${RUN_ID}-${n}`,
    slug: `coupon-product-${RUN_ID}-${n}`,
    sku: `CPN-SKU-${RUN_ID}-${n}`,
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

async function makeCoupon(overrides: Partial<{
  code: string;
  name: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderValue: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;
  status: CouponStatus;
}> = {}) {
  couponSeq += 1;
  const coupon = await Coupon.create({
    code: overrides.code ?? `KAI${RUN_ID}${couponSeq}`,
    name: overrides.name ?? "Test coupon",
    discountType: overrides.discountType ?? "PERCENTAGE",
    discountValue: overrides.discountValue ?? 10,
    maxDiscountAmount: overrides.maxDiscountAmount ?? null,
    minOrderValue: overrides.minOrderValue ?? 0,
    startsAt: overrides.startsAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    usageLimit: overrides.usageLimit ?? null,
    usageLimitPerUser: overrides.usageLimitPerUser ?? null,
    usedCount: overrides.usedCount ?? 0,
    status: overrides.status ?? "ACTIVE",
  });
  createdCouponIds.push(coupon._id);
  return coupon;
}

function validate(user: InstanceType<typeof User>, body: object) {
  return request(app).post("/api/coupons/validate").set("Cookie", authCookie(user)).send(body);
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

// ---- Pure helpers ----

describe("canonicalizeCouponCode", () => {
  it("uppercases, trims and strips inner whitespace", () => {
    expect(canonicalizeCouponCode("kaicho10")).toBe("KAICHO10");
    expect(canonicalizeCouponCode("  Kaicho10 ")).toBe("KAICHO10");
    expect(canonicalizeCouponCode("KAI CHO 10")).toBe("KAICHO10");
    expect(canonicalizeCouponCode(undefined)).toBe("");
  });
});

describe("getEffectiveCouponStatus", () => {
  const now = new Date("2026-06-15T00:00:00Z");
  it("is ACTIVE for an ACTIVE coupon inside its window", () => {
    expect(getEffectiveCouponStatus({ status: "ACTIVE", startsAt: null, expiresAt: null }, now)).toBe("ACTIVE");
  });
  it("is EXPIRED for an ACTIVE coupon past expiry", () => {
    expect(
      getEffectiveCouponStatus(
        { status: "ACTIVE", startsAt: null, expiresAt: new Date("2026-06-14T00:00:00Z") },
        now
      )
    ).toBe("EXPIRED");
  });
  it("is SCHEDULED for an ACTIVE coupon before its start", () => {
    expect(
      getEffectiveCouponStatus(
        { status: "ACTIVE", startsAt: new Date("2026-06-16T00:00:00Z"), expiresAt: null },
        now
      )
    ).toBe("SCHEDULED");
  });
  it("passes DRAFT / PAUSED / ARCHIVED straight through", () => {
    for (const status of ["DRAFT", "PAUSED", "ARCHIVED"] as const) {
      expect(getEffectiveCouponStatus({ status, startsAt: null, expiresAt: null }, now)).toBe(status);
    }
  });
});

describe("computeCouponDiscount", () => {
  const rule = (over: Partial<{ discountType: CouponDiscountType; discountValue: number; maxDiscountAmount: number | null }>) => ({
    discountType: over.discountType ?? "PERCENTAGE",
    discountValue: over.discountValue ?? 10,
    maxDiscountAmount: over.maxDiscountAmount ?? null,
  });

  it("percentage: 10% of 1000 is 100", () => {
    expect(computeCouponDiscount(rule({ discountValue: 10 }), 1000)).toEqual({
      discountType: "PERCENTAGE",
      discountAmount: 100,
      freeDelivery: false,
    });
  });

  it("percentage: caps at maxDiscountAmount", () => {
    expect(computeCouponDiscount(rule({ discountValue: 20, maxDiscountAmount: 300 }), 2000).discountAmount).toBe(300);
  });

  it("fixed: flat amount, never more than the subtotal", () => {
    expect(computeCouponDiscount(rule({ discountType: "FIXED", discountValue: 200 }), 1000).discountAmount).toBe(200);
    expect(computeCouponDiscount(rule({ discountType: "FIXED", discountValue: 500 }), 300).discountAmount).toBe(300);
  });

  it("free delivery: no subtotal discount, freeDelivery flag set", () => {
    expect(computeCouponDiscount(rule({ discountType: "FREE_DELIVERY", discountValue: 0 }), 1000)).toEqual({
      discountType: "FREE_DELIVERY",
      discountAmount: 0,
      freeDelivery: true,
    });
  });

  it("does not drift on fractional-rupee subtotals", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float; integer paise must not.
    expect(computeCouponDiscount(rule({ discountValue: 10 }), 0.1 + 0.2).discountAmount).toBe(0.03);
  });
});

// ---- POST /api/coupons/validate ----

describe("POST /api/coupons/validate — auth", () => {
  it("401s without a session", async () => {
    const res = await request(app).post("/api/coupons/validate").send({ code: "X", items: [] });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/coupons/validate — happy paths", () => {
  it("applies a percentage discount and recomputes pricing from the DB", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800 }); // 2 x 800 = 1600 subtotal, free shipping
    const coupon = await makeCoupon({ discountType: "PERCENTAGE", discountValue: 10 });

    const res = await validate(user, {
      code: coupon.code.toLowerCase(), // canonicalisation is exercised
      items: [{ productId: product._id.toString(), quantity: 2 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.coupon).toEqual({ code: coupon.code, name: "Test coupon" });
    expect(res.body.data.discount).toEqual({ type: "PERCENTAGE", amount: 160, freeDelivery: false });
    expect(res.body.data.pricing).toEqual({ subtotal: 1600, discount: 160, delivery: 0, total: 1440 });
  });

  it("applies a fixed discount", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800 });
    const coupon = await makeCoupon({ discountType: "FIXED", discountValue: 200 });

    const res = await validate(user, {
      code: coupon.code,
      items: [{ productId: product._id.toString(), quantity: 1 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.discount).toEqual({ type: "FIXED", amount: 200, freeDelivery: false });
    // 800 subtotal < 499 threshold? no — 800 >= 499, shipping already free.
    expect(res.body.data.pricing).toEqual({ subtotal: 800, discount: 200, delivery: 0, total: 600 });
  });

  it("free-delivery coupon waives the shipping fee, not the subtotal", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 300 }); // below the 499 free-ship threshold
    const coupon = await makeCoupon({ discountType: "FREE_DELIVERY", discountValue: 0 });

    const res = await validate(user, {
      code: coupon.code,
      items: [{ productId: product._id.toString(), quantity: 1 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.discount).toEqual({ type: "FREE_DELIVERY", amount: 0, freeDelivery: true });
    expect(res.body.data.pricing).toEqual({ subtotal: 300, discount: 0, delivery: 0, total: 300 });
  });

  it("honours maxDiscountAmount", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800 });
    const coupon = await makeCoupon({ discountType: "PERCENTAGE", discountValue: 50, maxDiscountAmount: 100 });

    const res = await validate(user, {
      code: coupon.code,
      items: [{ productId: product._id.toString(), quantity: 2 }], // 50% of 1600 = 800, capped to 100
    });

    expect(res.body.data.discount.amount).toBe(100);
    expect(res.body.data.pricing.total).toBe(1500);
  });

  it("never increments usedCount", async () => {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800 });
    const coupon = await makeCoupon({ discountType: "PERCENTAGE", discountValue: 10, usageLimit: 100 });

    await validate(user, { code: coupon.code, items: [{ productId: product._id.toString(), quantity: 1 }] });
    await validate(user, { code: coupon.code, items: [{ productId: product._id.toString(), quantity: 1 }] });

    const fresh = await Coupon.findById(coupon._id).lean();
    expect(fresh!.usedCount).toBe(0);
    expect(await CouponUsage.countDocuments({ couponId: coupon._id })).toBe(0);
  });
});

describe("POST /api/coupons/validate — rejections", () => {
  async function setup() {
    const user = await makeUser();
    const product = await makeProduct({ sellingPrice: 800 });
    return { user, product, line: { productId: product._id.toString(), quantity: 2 } }; // 1600 subtotal
  }

  it("unknown code → generic 400", async () => {
    const { user, line } = await setup();
    const res = await validate(user, { code: "NOPE-DOES-NOT-EXIST", items: [line] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/isn't valid/i);
  });

  it("expired coupon → 400 'expired'", async () => {
    const { user, line } = await setup();
    const coupon = await makeCoupon({ expiresAt: new Date(Date.now() - 60_000) });
    const res = await validate(user, { code: coupon.code, items: [line] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/i);
  });

  it("not-yet-started coupon → 400 'not active yet'", async () => {
    const { user, line } = await setup();
    const coupon = await makeCoupon({ startsAt: new Date(Date.now() + 3_600_000) });
    const res = await validate(user, { code: coupon.code, items: [line] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/active yet/i);
  });

  it("paused / draft / archived coupon → generic 400 (no state leak)", async () => {
    const { user, line } = await setup();
    for (const status of ["PAUSED", "DRAFT", "ARCHIVED"] as const) {
      const coupon = await makeCoupon({ status });
      const res = await validate(user, { code: coupon.code, items: [line] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/isn't valid/i);
    }
  });

  it("minimum order not met → 400 with the shortfall", async () => {
    const { user, line } = await setup();
    const coupon = await makeCoupon({ minOrderValue: 5000 });
    const res = await validate(user, { code: coupon.code, items: [line] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/minimum order/i);
  });

  it("global usage limit reached → 400", async () => {
    const { user, line } = await setup();
    const coupon = await makeCoupon({ usageLimit: 5, usedCount: 5 });
    const res = await validate(user, { code: coupon.code, items: [line] });
    expect(res.status).toBe(400);
  });

  it("per-user limit reached → 400 'already used'", async () => {
    const { user, line } = await setup();
    const coupon = await makeCoupon({ usageLimitPerUser: 1 });
    await CouponUsage.create({
      couponId: coupon._id,
      couponCode: coupon.code,
      userId: user._id,
      orderId: new mongoose.Types.ObjectId(),
      orderNumber: "ORD-TEST",
      discountType: "PERCENTAGE",
      discountAmount: 10,
      freeDelivery: false,
      perUserSeq: 1,
      usedAt: new Date(),
    });
    const res = await validate(user, { code: coupon.code, items: [line] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already used/i);
  });
});
