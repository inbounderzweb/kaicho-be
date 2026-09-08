import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order, Coupon, CouponUsage } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureCouponIndexes } from "../coupon.indexes";

// The point of these tests: the coupon system has NO database transactions
// available, so consumeCouponForOrder relies on an atomic $inc guarded by the
// usage limit plus two unique indexes. Under a burst of concurrent checkouts
// the number of successful redemptions must exactly equal the configured
// limit — never more.

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];
const createdCouponIds: mongoose.Types.ObjectId[] = [];
let couponSeq = 0;
// Synchronous counters — makeUser / makeProduct are called concurrently
// (Promise.all), so reading `createdXIds.length` after the first await would
// hand several callers the same value and collide on the unique phone/sku
// indexes.
let userSeq = 0;
let productSeq = 0;

async function makeUser() {
  const seq = userSeq++;
  const user = await User.create({
    phone: `76${RUN_ID}${String(seq).padStart(3, "0")}`,
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

async function makeProduct(stock: number) {
  const n = productSeq++;
  const product = await Product.create({
    name: `Concurrency Product ${RUN_ID}-${n}`,
    slug: `concurrency-product-${RUN_ID}-${n}`,
    sku: `CNC-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1000, sellingPrice: 800 },
    inventory: { stockQuantity: stock, lowStockThreshold: 2, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["concurrency"] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

async function makeCoupon(overrides: Record<string, unknown>) {
  couponSeq += 1;
  const coupon = await Coupon.create({
    code: `CNC${RUN_ID}${couponSeq}`,
    name: "Concurrency coupon",
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

function checkout(user: InstanceType<typeof User>, body: object, key: string) {
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

describe("coupon concurrency — global usage limit", () => {
  it("exactly one of N concurrent checkouts consumes a usageLimit=1 coupon", async () => {
    const CONCURRENCY = 8;
    const coupon = await makeCoupon({ usageLimit: 1 });

    const participants = await Promise.all(
      Array.from({ length: CONCURRENCY }).map(async () => {
        const user = await makeUser();
        const product = await makeProduct(5);
        const addressId = await makeAddress(user);
        return { user, product, addressId };
      })
    );

    const results = await Promise.all(
      participants.map((p, i) =>
        checkout(
          p.user,
          {
            items: [{ productId: p.product._id.toString(), quantity: 1 }],
            addressId: p.addressId,
            paymentMethod: "COD",
            couponCode: coupon.code,
          },
          `cnc-global-${RUN_ID}-${i}`
        )
      )
    );

    const succeeded = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);
    expect(succeeded[0].body.data.order.coupon.code).toBe(coupon.code);
    expect(succeeded[0].body.data.order.pricing.discountTotal).toBeGreaterThan(0);

    const fresh = await Coupon.findById(coupon._id).lean();
    expect(fresh!.usedCount).toBe(1);
    expect(await CouponUsage.countDocuments({ couponId: coupon._id })).toBe(1);

    // Every rejected checkout must have fully rolled back — no order, stock intact.
    expect(await Order.countDocuments({ "coupon.couponId": coupon._id })).toBe(1);
    for (const p of participants) {
      const prod = await Product.findById(p.product._id).lean();
      // The one winner is 1 short; everyone else is untouched.
      expect([4, 5]).toContain(prod!.inventory.stockQuantity);
    }
  });

  it("exactly K of N concurrent checkouts consume a usageLimit=K coupon", async () => {
    const CONCURRENCY = 8;
    const LIMIT = 3;
    const coupon = await makeCoupon({ usageLimit: LIMIT });

    const participants = await Promise.all(
      Array.from({ length: CONCURRENCY }).map(async () => {
        const user = await makeUser();
        const product = await makeProduct(5);
        const addressId = await makeAddress(user);
        return { user, product, addressId };
      })
    );

    const results = await Promise.all(
      participants.map((p, i) =>
        checkout(
          p.user,
          {
            items: [{ productId: p.product._id.toString(), quantity: 1 }],
            addressId: p.addressId,
            paymentMethod: "COD",
            couponCode: coupon.code,
          },
          `cnc-k-${RUN_ID}-${i}`
        )
      )
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(LIMIT);
    const fresh = await Coupon.findById(coupon._id).lean();
    expect(fresh!.usedCount).toBe(LIMIT);
    expect(await CouponUsage.countDocuments({ couponId: coupon._id })).toBe(LIMIT);
  });
});

describe("coupon concurrency — per-user limit", () => {
  it("one user firing N concurrent checkouts consumes a usageLimitPerUser=1 coupon exactly once", async () => {
    const CONCURRENCY = 6;
    const coupon = await makeCoupon({ usageLimitPerUser: 1, usageLimit: 100 });
    const user = await makeUser();
    const product = await makeProduct(CONCURRENCY + 2); // enough stock that stock is never the limiter
    const addressId = await makeAddress(user);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }).map((_, i) =>
        checkout(
          user,
          {
            items: [{ productId: product._id.toString(), quantity: 1 }],
            addressId,
            paymentMethod: "COD",
            couponCode: coupon.code,
          },
          `cnc-peruser-${RUN_ID}-${i}`
        )
      )
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(CONCURRENCY - 1);

    const fresh = await Coupon.findById(coupon._id).lean();
    expect(fresh!.usedCount).toBe(1);
    expect(await CouponUsage.countDocuments({ couponId: coupon._id, userId: user._id })).toBe(1);
  });
});
