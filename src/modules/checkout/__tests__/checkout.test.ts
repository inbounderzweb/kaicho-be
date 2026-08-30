import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order, ProductStatus } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { computeOrderTotals, FREE_SHIPPING_THRESHOLD, FLAT_SHIPPING_FEE } from "../checkout.service";

// COD is used throughout: it exercises the whole stock/idempotency/order
// creation path without touching Razorpay's SDK at all. The gateway-specific
// half is covered in modules/payment/__tests__.

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];
const createdOrderIds: mongoose.Types.ObjectId[] = [];

async function makeUser() {
  const user = await User.create({
    phone: `72${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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

// Products are created straight through the model rather than
// product.service.createProduct: these tests care only about
// status/pricing/inventory, and going through the service would drag in
// category/brand/media fixtures that prove nothing here.
async function makeProduct(options: {
  stock?: number;
  trackInventory?: boolean;
  status?: ProductStatus;
  sellingPrice?: number;
  mrp?: number;
} = {}) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Checkout Product ${RUN_ID}-${n}`,
    slug: `checkout-product-${RUN_ID}-${n}`,
    sku: `CO-SKU-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: options.mrp ?? 1000, sellingPrice: options.sellingPrice ?? 800 },
    inventory: {
      stockQuantity: options.stock ?? 10,
      lowStockThreshold: 2,
      trackInventory: options.trackInventory ?? true,
    },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["checkout"] },
    status: options.status ?? "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

async function makeAddress(user: InstanceType<typeof User>): Promise<string> {
  const res = await request(app)
    .post("/api/addresses")
    .set("Cookie", authCookie(user))
    .send({ label: "Home", line1: "12 Marine Drive", city: "Mumbai", state: "Maharashtra", pincode: "400020" });
  return res.body.data.address.addressId;
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const doc = await Product.findById(productId).select("inventory").lean();
  return doc!.inventory.stockQuantity;
}

function checkout(
  user: InstanceType<typeof User>,
  body: object,
  idempotencyKey: string | null = `key-${RUN_ID}-${Math.random().toString(36).slice(2)}`
) {
  const req = request(app).post("/api/checkout").set("Cookie", authCookie(user));
  if (idempotencyKey) req.set("Idempotency-Key", idempotencyKey);
  return req.send(body);
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Order.deleteMany({ _id: { $in: createdOrderIds } });
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("computeOrderTotals", () => {
  it("charges flat shipping below the free-shipping threshold", () => {
    const totals = computeOrderTotals([100, 50]);
    expect(totals.subtotal).toBe(150);
    expect(totals.shippingFee).toBe(FLAT_SHIPPING_FEE);
    expect(totals.taxTotal).toBe(0);
    expect(totals.grandTotal).toBe(150 + FLAT_SHIPPING_FEE);
  });

  it("waives shipping at or above the threshold", () => {
    const totals = computeOrderTotals([FREE_SHIPPING_THRESHOLD]);
    expect(totals.shippingFee).toBe(0);
    expect(totals.grandTotal).toBe(FREE_SHIPPING_THRESHOLD);
  });

  it("does not drift on fractional-rupee lines", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float; integer paise must not.
    const totals = computeOrderTotals([0.1, 0.2]);
    expect(totals.subtotal).toBe(0.3);
  });
});

describe("Checkout API — auth and validation", () => {
  it("401s without a session", async () => {
    const res = await request(app).post("/api/checkout/preview").send({ items: [] });
    expect(res.status).toBe(401);
  });

  it("400s when the Idempotency-Key header is missing", async () => {
    const user = await makeUser();
    const product = await makeProduct();
    const addressId = await makeAddress(user);

    const res = await checkout(
      user,
      { items: [{ productId: product._id.toString(), quantity: 1 }], addressId, paymentMethod: "COD" },
      null
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key/i);
  });

  it("404s on an address the user does not own", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const product = await makeProduct();
    const otherAddressId = await makeAddress(other);

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 1 }],
      addressId: otherAddressId,
      paymentMethod: "COD",
    });
    expect(res.status).toBe(404);
  });
});

describe("Checkout preview", () => {
  it("recomputes pricing from the DB and never mutates stock", async () => {
    const user = await makeUser();
    const product = await makeProduct({ stock: 5, mrp: 1000, sellingPrice: 800 });

    const res = await request(app)
      .post("/api/checkout/preview")
      .set("Cookie", authCookie(user))
      .send({ items: [{ productId: product._id.toString(), quantity: 2 }] });

    expect(res.status).toBe(200);
    const line = res.body.data.items[0];
    expect(line.unitPrice).toBe(800);
    expect(line.mrp).toBe(1000);
    expect(line.discount).toBe(200);
    expect(line.discountPercentage).toBe(20);
    expect(line.lineTotal).toBe(1600);
    expect(res.body.data.pricing.subtotal).toBe(1600);
    expect(res.body.data.pricing.shippingFee).toBe(0);
    expect(await stockOf(product._id)).toBe(5);
  });

  it("flags an insufficient-stock line without throwing", async () => {
    const user = await makeUser();
    const product = await makeProduct({ stock: 1 });

    const res = await request(app)
      .post("/api/checkout/preview")
      .set("Cookie", authCookie(user))
      .send({ items: [{ productId: product._id.toString(), quantity: 3 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].insufficientStock).toBe(true);
    expect(res.body.data.items[0].availableQuantity).toBe(1);
    expect(res.body.data.hasIssues).toBe(true);
  });

  it("flags a non-ACTIVE product as unavailable", async () => {
    const user = await makeUser();
    const product = await makeProduct({ status: "DRAFT" });

    const res = await request(app)
      .post("/api/checkout/preview")
      .set("Cookie", authCookie(user))
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    expect(res.body.data.items[0].unavailable).toBe(true);
  });
});

describe("Checkout — stock reservation", () => {
  it("creates a COD order and decrements stock", async () => {
    const user = await makeUser();
    const product = await makeProduct({ stock: 10, sellingPrice: 800 });
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 3 }],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
    expect(res.body.data.order.status).toBe("CONFIRMED");
    expect(res.body.data.order.paymentStatus).toBe("PENDING");
    expect(res.body.data.order.pricing.subtotal).toBe(2400);
    expect(res.body.data.order.items[0].quantity).toBe(3);
    // Line data is snapshotted, not referenced.
    expect(res.body.data.order.items[0].name).toBe(product.name);
    expect(res.body.data.order.items[0].sku).toBe(product.sku);
    expect(await stockOf(product._id)).toBe(7);
  });

  it("does not touch stock for a product with trackInventory: false", async () => {
    const user = await makeUser();
    const product = await makeProduct({ stock: 0, trackInventory: false });
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 5 }],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    expect(await stockOf(product._id)).toBe(0);
  });

  it("409s and rolls back earlier lines when a later line has insufficient stock", async () => {
    const user = await makeUser();
    const good = await makeProduct({ stock: 10 });
    const scarce = await makeProduct({ stock: 1 });
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        { productId: good._id.toString(), quantity: 4 },
        { productId: scarce._id.toString(), quantity: 5 },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Insufficient stock/i);
    // The compensating rollback is the whole point: the first line's stock
    // must be back exactly where it started, not 4 short.
    expect(await stockOf(good._id)).toBe(10);
    expect(await stockOf(scarce._id)).toBe(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
  });

  it("409s and rolls back when a line's product is not ACTIVE", async () => {
    const user = await makeUser();
    const good = await makeProduct({ stock: 10 });
    const draft = await makeProduct({ stock: 10, status: "DRAFT" });
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        { productId: good._id.toString(), quantity: 2 },
        { productId: draft._id.toString(), quantity: 1 },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(409);
    expect(await stockOf(good._id)).toBe(10);
  });
});

describe("Checkout — idempotency", () => {
  it("replaying the same Idempotency-Key returns the same order without double-decrementing", async () => {
    const user = await makeUser();
    const product = await makeProduct({ stock: 10 });
    const addressId = await makeAddress(user);
    const key = `replay-${RUN_ID}-${Date.now()}`;
    const body = {
      items: [{ productId: product._id.toString(), quantity: 2 }],
      addressId,
      paymentMethod: "COD",
    };

    const first = await checkout(user, body, key);
    expect(first.status).toBe(201);
    expect(await stockOf(product._id)).toBe(8);

    const second = await checkout(user, body, key);
    // 200, not 201 — the client can tell "your retry found it" from "a new
    // order was placed".
    expect(second.status).toBe(200);
    expect(second.body.data.order.orderNumber).toBe(first.body.data.order.orderNumber);
    expect(await stockOf(product._id)).toBe(8);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  it("a different key from the same user places a genuinely separate order", async () => {
    const user = await makeUser();
    const product = await makeProduct({ stock: 10 });
    const addressId = await makeAddress(user);
    const body = {
      items: [{ productId: product._id.toString(), quantity: 1 }],
      addressId,
      paymentMethod: "COD",
    };

    const first = await checkout(user, body, `a-${RUN_ID}-${Date.now()}`);
    const second = await checkout(user, body, `b-${RUN_ID}-${Date.now()}`);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.order.orderNumber).not.toBe(first.body.data.order.orderNumber);
    expect(await stockOf(product._id)).toBe(8);
  });
});
