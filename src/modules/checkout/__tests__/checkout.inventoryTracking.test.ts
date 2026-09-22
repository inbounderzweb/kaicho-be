import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Product, Order } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeUser() {
  const user = await User.create({
    phone: `78${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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

async function makeBaseProduct(name: string, stock: number) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `${name} ${RUN_ID}-${n}`,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}-${n}`,
    sku: `BASE-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 120, sellingPrice: 100 },
    inventory: { stockQuantity: stock, lowStockThreshold: 5, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: [name.toLowerCase()] },
    status: "ACTIVE",
  });
  createdProductIds.push(product._id);
  return product;
}

// "Premium Porridge Combo" from the spec's own §6 example — its own catalog
// listing, purchased as a plain quantity (no pack selection at all), whose
// individual-purchase inventory tracking deducts from the four components.
async function makeComboProduct(
  components: { productId: mongoose.Types.ObjectId; quantity: number }[],
  overrides: { price?: number } = {}
) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Premium Porridge Combo ${RUN_ID}-${n}`,
    slug: `combo-${RUN_ID}-${n}`,
    sku: `COMBO-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1200, sellingPrice: overrides.price ?? 1000 },
    // Deliberately mismatched — proves the combo doesn't touch its own
    // stock counter at all once tracking is enabled.
    inventory: { stockQuantity: 0, lowStockThreshold: 5, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["combo"] },
    status: "ACTIVE",
    inventoryTracking: { enabled: true, components },
  });
  createdProductIds.push(product._id);
  return product;
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

function checkout(user: InstanceType<typeof User>, body: object, key = `iv-${RUN_ID}-${Math.random().toString(36).slice(2)}`) {
  return request(app)
    .post("/api/checkout")
    .set("Cookie", authCookie(user))
    .set("Idempotency-Key", key)
    .send(body);
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const doc = await Product.findById(productId).lean();
  return doc!.inventory.stockQuantity;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Order.deleteMany({ userId: { $in: createdUserIds } });
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Combo checkout — 4-product component deduction (spec §6)", () => {
  it("deducts every component atomically when the combo is purchased as a plain quantity", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 50);
    const millet = await makeBaseProduct("Millet", 50);
    const ragi = await makeBaseProduct("Ragi", 50);
    const oats = await makeBaseProduct("Oats", 50);
    const combo = await makeComboProduct([
      { productId: navadhanya._id, quantity: 1 },
      { productId: millet._id, quantity: 1 },
      { productId: ragi._id, quantity: 1 },
      { productId: oats._id, quantity: 1 },
    ]);

    const user = await makeUser();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: combo._id.toString(), quantity: 5 }], // plain UNIT purchase, no pack
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    const item = res.body.data.order.items[0];
    expect(item.quantity).toBe(5);
    expect(item.inventoryComponents).toBeTruthy();
    const byId = Object.fromEntries(item.inventoryComponents.map((c: { productId: string; quantity: number }) => [c.productId, c.quantity]));
    expect(byId[navadhanya._id.toString()]).toBe(5);
    expect(byId[millet._id.toString()]).toBe(5);
    expect(byId[ragi._id.toString()]).toBe(5);
    expect(byId[oats._id.toString()]).toBe(5);

    // Each component down by exactly 5 — the combo's OWN stock (seeded at 0) untouched.
    expect(await stockOf(navadhanya._id)).toBe(45);
    expect(await stockOf(millet._id)).toBe(45);
    expect(await stockOf(ragi._id)).toBe(45);
    expect(await stockOf(oats._id)).toBe(45);
    expect(await stockOf(combo._id)).toBe(0);
  });

  it("uneven per-component quantities (Family Combo, spec §7)", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 50);
    const millet = await makeBaseProduct("Millet", 50);
    const ragi = await makeBaseProduct("Ragi", 50);
    const combo = await makeComboProduct([
      { productId: navadhanya._id, quantity: 2 },
      { productId: millet._id, quantity: 1 },
      { productId: ragi._id, quantity: 3 },
    ]);

    const user = await makeUser();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: combo._id.toString(), quantity: 2 }],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    expect(await stockOf(navadhanya._id)).toBe(50 - 4);
    expect(await stockOf(millet._id)).toBe(50 - 2);
    expect(await stockOf(ragi._id)).toBe(50 - 6);
  });
});

describe("No partial deduction on failure (spec §17)", () => {
  it("insufficient stock on ONE component blocks the whole order and leaves every component untouched", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 50);
    const millet = await makeBaseProduct("Millet", 50);
    const ragi = await makeBaseProduct("Ragi", 2); // only 2 — combo needs 3 per unit
    const combo = await makeComboProduct([
      { productId: navadhanya._id, quantity: 2 },
      { productId: millet._id, quantity: 1 },
      { productId: ragi._id, quantity: 3 },
    ]);

    const user = await makeUser();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: combo._id.toString(), quantity: 1 }],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(409);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    // Navadhanya and Millet must NOT have been deducted even though they
    // individually had enough stock — the whole order failed on Ragi.
    expect(await stockOf(navadhanya._id)).toBe(50);
    expect(await stockOf(millet._id)).toBe(50);
    expect(await stockOf(ragi._id)).toBe(2);
  });
});

describe("Shared component across two lines in one order", () => {
  it("doesn't oversell a component that's both bought directly and required by a combo", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 10);
    const millet = await makeBaseProduct("Millet", 50);
    // Combo needs 8 Navadhanya per unit; buying the combo once (8) plus 5
    // loose Navadhanya = 13 required against only 10 in stock — must fail.
    const combo = await makeComboProduct([
      { productId: navadhanya._id, quantity: 8 },
      { productId: millet._id, quantity: 1 },
    ]);

    const user = await makeUser();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        { productId: combo._id.toString(), quantity: 1 },
        { productId: navadhanya._id.toString(), quantity: 5 },
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(409);
    expect(await stockOf(navadhanya._id)).toBe(10); // untouched — no partial deduction
  });

  it("succeeds and deducts the combined total when stock covers both lines", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 20);
    const millet = await makeBaseProduct("Millet", 50);
    const combo = await makeComboProduct([
      { productId: navadhanya._id, quantity: 8 },
      { productId: millet._id, quantity: 1 },
    ]);

    const user = await makeUser();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [
        { productId: combo._id.toString(), quantity: 1 }, // needs 8 Navadhanya
        { productId: navadhanya._id.toString(), quantity: 5 }, // + 5 loose
      ],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    expect(await stockOf(navadhanya._id)).toBe(20 - 8 - 5);
  });
});

describe("Cancellation restores every component (spec §18)", () => {
  it("cancelling a combo order restores each component's stock", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 50);
    const ragi = await makeBaseProduct("Ragi", 50);
    const combo = await makeComboProduct([
      { productId: navadhanya._id, quantity: 2 },
      { productId: ragi._id, quantity: 3 },
    ]);

    const user = await makeUser();
    const addressId = await makeAddress(user);

    const placed = await checkout(user, {
      items: [{ productId: combo._id.toString(), quantity: 4 }],
      addressId,
      paymentMethod: "COD",
    });
    expect(placed.status).toBe(201);
    expect(await stockOf(navadhanya._id)).toBe(50 - 8);
    expect(await stockOf(ragi._id)).toBe(50 - 12);

    const orderNumber = placed.body.data.order.orderNumber;
    const cancelled = await request(app)
      .post(`/api/orders/${encodeURIComponent(orderNumber)}/cancel`)
      .set("Cookie", authCookie(user))
      .send({ reason: "changed my mind" });
    expect(cancelled.status).toBe(200);

    expect(await stockOf(navadhanya._id)).toBe(50);
    expect(await stockOf(ragi._id)).toBe(50);
  });
});

describe("Backward compatibility — untouched products/packs are unaffected (spec §9/§10)", () => {
  it("a plain product with no inventoryTracking checks out exactly as before", async () => {
    const product = await makeBaseProduct("Legacy", 20);
    const user = await makeUser();
    const addressId = await makeAddress(user);

    const res = await checkout(user, {
      items: [{ productId: product._id.toString(), quantity: 3 }],
      addressId,
      paymentMethod: "COD",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.items[0].inventoryComponents).toBeUndefined();
    expect(await stockOf(product._id)).toBe(17);
  });
});
