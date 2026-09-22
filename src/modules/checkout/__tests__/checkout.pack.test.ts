import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order, Coupon, CouponUsage } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];
const createdCouponIds: mongoose.Types.ObjectId[] = [];
let couponSeq = 0;

async function makeUser() {
  const user = await User.create({
    phone: `77${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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

// Navadhanya, straight from the spec: 5/450, 10/850, 20/1600, admin priority,
// mixed packs allowed, 500 units of base stock.
async function makeNavadhanya(overrides: {
  stock?: number;
  mixedPacksAllowed?: boolean;
  strategy?: "CHEAPEST" | "LARGEST_FIRST" | "SMALLEST_FIRST" | "ADMIN_PRIORITY" | "MANUAL_ONLY";
} = {}) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Navadhanya ${RUN_ID}-${n}`,
    slug: `navadhanya-checkout-${RUN_ID}-${n}`,
    sku: `NAV-CO-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 120, sellingPrice: 100 },
    inventory: { stockQuantity: overrides.stock ?? 500, lowStockThreshold: 10, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["navadhanya"] },
    status: "ACTIVE",
    packConfig: {
      enabled: true,
      mode: "CUSTOM",
      mixedPacksAllowed: overrides.mixedPacksAllowed ?? true,
      recommendationStrategy: overrides.strategy ?? "ADMIN_PRIORITY",
      packs: [
        { name: "Pack of 5", quantity: 5, price: 450, isActive: true, isDefault: false, sortOrder: 0 },
        { name: "Pack of 10", quantity: 10, price: 850, isActive: true, isDefault: false, sortOrder: 1 },
        { name: "Pack of 20", quantity: 20, price: 1600, isActive: true, isDefault: false, sortOrder: 2 },
      ],
    },
  });
  createdProductIds.push(product._id);
  return product;
}

function packSelectionFor(product: InstanceType<typeof Product>, spec: { quantity: number; count: number }[]) {
  return spec.map((s) => {
    const pack = product.packConfig!.packs.find((p) => p.quantity === s.quantity)!;
    return { packId: pack._id.toString(), count: s.count };
  });
}

async function makeCoupon(overrides: Record<string, unknown> = {}) {
  couponSeq += 1;
  const coupon = await Coupon.create({
    code: `PACK${RUN_ID}${couponSeq}`,
    name: "Pack checkout coupon",
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

function checkout(user: InstanceType<typeof User>, body: object, key = `pk-${RUN_ID}-${Math.random().toString(36).slice(2)}`) {
  return request(app)
    .post("/api/checkout")
    .set("Cookie", authCookie(user))
    .set("Idempotency-Key", key)
    .send(body);
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await CouponUsage.deleteMany({ couponId: { $in: createdCouponIds } });
  await Coupon.deleteMany({ _id: { $in: createdCouponIds } });
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("POST /api/cart/validate-pack (public, no auth)", () => {
  it("recommends 20x2 + 10x1 for 50 units — the spec's headline scenario", async () => {
    const product = await makeNavadhanya();
    const res = await request(app).post("/api/cart/validate-pack").send({ productId: product._id.toString(), quantity: 50 });
    expect(res.status).toBe(200);
    expect(res.body.data.applicable).toBe(true);
    expect(res.body.data.totalPrice).toBe(4050);
    const byQty = new Map(res.body.data.breakdown.map((l: { packQuantity: number; packCount: number }) => [l.packQuantity, l.packCount]));
    expect(byQty.get(20)).toBe(2);
    expect(byQty.get(10)).toBe(1);
  });

  it("is not applicable for a product with packs disabled", async () => {
    const product = await Product.create({
      name: `Plain ${RUN_ID}`,
      slug: `plain-${RUN_ID}-${createdProductIds.length}`,
      sku: `PLN-${RUN_ID}-${createdProductIds.length}`,
      shortDescription: "Short description.",
      description: "A longer description of the product.",
      categoryId: new mongoose.Types.ObjectId(),
      brandId: new mongoose.Types.ObjectId(),
      pricing: { mrp: 120, sellingPrice: 100 },
      inventory: { stockQuantity: 50, lowStockThreshold: 10, trackInventory: true },
      seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["plain"] },
      status: "ACTIVE",
    });
    createdProductIds.push(product._id);

    const res = await request(app).post("/api/cart/validate-pack").send({ productId: product._id.toString(), quantity: 5 });
    expect(res.status).toBe(200);
    expect(res.body.data.applicable).toBe(false);
  });
});

describe("Checkout with a pack selection — 50 units (spec §5/§8/§11/§24)", () => {
  it("charges Pack Price × Number of Packs, not quantity × unit price", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        {
          productId: product._id.toString(),
          quantity: 999, // deliberately wrong/ignored — the pack selection is authoritative
          packSelection: packSelectionFor(product, [
            { quantity: 20, count: 2 },
            { quantity: 10, count: 1 },
          ]),
        },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    const item = res.body.data.order.items[0];
    expect(item.quantity).toBe(50); // total base units, never "3 packs"
    expect(item.selectionType).toBe("PACK");
    expect(item.lineTotal).toBe(4050);
    expect(res.body.data.order.pricing.subtotal).toBe(4050);
    // NOT 50 * 100 = 5000 — proves it isn't naive quantity * unit price.
    expect(res.body.data.order.pricing.subtotal).not.toBe(5000);

    const byQty = new Map(item.packBreakdown.map((l: { packQuantity: number; packCount: number }) => [l.packQuantity, l.packCount]));
    expect(byQty.get(20)).toBe(2);
    expect(byQty.get(10)).toBe(1);

    // Inventory deducted by the TOTAL underlying quantity (50), not by pack
    // count (3) — spec §11's core requirement.
    const fresh = await Product.findById(product._id).lean();
    expect(fresh!.inventory.stockQuantity).toBe(500 - 50);
  });

  it("rejects a pack combination that would exceed available stock (spec §12)", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya({ stock: 40 });
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        {
          productId: product._id.toString(),
          quantity: 50,
          packSelection: packSelectionFor(product, [
            { quantity: 20, count: 2 },
            { quantity: 10, count: 1 },
          ]),
        },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(409);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    const fresh = await Product.findById(product._id).lean();
    expect(fresh!.inventory.stockQuantity).toBe(40); // untouched
  });

  it("rejects an inactive/unknown pack id rather than silently falling back", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        {
          productId: product._id.toString(),
          quantity: 10,
          packSelection: [{ packId: new mongoose.Types.ObjectId().toString(), count: 1 }],
        },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(409);
  });

  it("rejects mixing pack sizes when the product disallows it (spec §9)", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya({ mixedPacksAllowed: false });
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        {
          productId: product._id.toString(),
          quantity: 30,
          packSelection: packSelectionFor(product, [
            { quantity: 20, count: 1 },
            { quantity: 10, count: 1 },
          ]),
        },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(400);
  });

  it("a plain unit line (no packSelection) still works exactly as before — regression check", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 3 }], // below the smallest pack
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    const item = res.body.data.order.items[0];
    expect(item.selectionType).toBe("UNIT");
    expect(item.quantity).toBe(3);
    expect(item.lineTotal).toBe(300); // 3 * sellingPrice(100), untouched by packs
  });

  it("an existing product with no packConfig at all checks out exactly as before this feature existed", async () => {
    const user = await makeUser();
    const product = await Product.create({
      name: `Legacy ${RUN_ID}`,
      slug: `legacy-${RUN_ID}-${createdProductIds.length}`,
      sku: `LEG-${RUN_ID}-${createdProductIds.length}`,
      shortDescription: "Short description.",
      description: "A longer description of the product.",
      categoryId: new mongoose.Types.ObjectId(),
      brandId: new mongoose.Types.ObjectId(),
      pricing: { mrp: 220, sellingPrice: 200 },
      inventory: { stockQuantity: 20, lowStockThreshold: 2, trackInventory: true },
      seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["legacy"] },
      status: "ACTIVE",
    });
    createdProductIds.push(product._id);
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 2 }],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.items[0].selectionType).toBe("UNIT");
    expect(res.body.data.order.items[0].lineTotal).toBe(400);
    expect(res.body.data.order.items[0].packBreakdown).toBeUndefined();
  });

  it("coupon discount applies to the PACK-derived subtotal, not quantity * unit price (coupon + pack)", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya();
    const addressId = await makeAddress(user);
    const coupon = await makeCoupon({ discountType: "PERCENTAGE", discountValue: 10 });

    const res = await checkout(user, {
      items: [
        {
          productId: product._id.toString(),
          quantity: 50,
          packSelection: packSelectionFor(product, [
            { quantity: 20, count: 2 },
            { quantity: 10, count: 1 },
          ]),
        },
      ],
      addressId,
      paymentMethod: "COD",
      couponCode: coupon.code,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.pricing.subtotal).toBe(4050);
    expect(res.body.data.order.pricing.discountTotal).toBe(405); // 10% of 4050, not of 5000
    expect(res.body.data.order.pricing.grandTotal).toBe(4050 - 405);
  });

  it("a pack price change after the order was placed never touches the historical order (spec §20)", async () => {
    const user = await makeUser();
    const product = await makeNavadhanya();
    const addressId = await makeAddress(user);

    const placed = await checkout(user, {
      items: [
        {
          productId: product._id.toString(),
          quantity: 20,
          packSelection: packSelectionFor(product, [{ quantity: 20, count: 1 }]),
        },
      ],
      addressId,
      paymentMethod: "COD",
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.order.items[0].lineTotal).toBe(1600);

    // Admin later reprices the pack of 20.
    const pack20Id = product.packConfig!.packs.find((p) => p.quantity === 20)!._id;
    await Product.updateOne(
      { _id: product._id, "packConfig.packs._id": pack20Id },
      { $set: { "packConfig.packs.$.price": 1999 } }
    );

    const orderNumber = placed.body.data.order.orderNumber;
    const fetched = await request(app)
      .get(`/api/orders/${encodeURIComponent(orderNumber)}`)
      .set("Cookie", authCookie(user));
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.order.items[0].lineTotal).toBe(1600); // unchanged
    expect(fetched.body.data.order.items[0].packBreakdown[0].packPrice).toBe(1600);
  });
});
