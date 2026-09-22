import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { Product } from "../../../database/models";

// Regression coverage for a bug where a combo product with plenty of
// component stock still showed as "out of stock" on the catalog grid and
// related-products list — those two list views computed inStock/stockQuantity
// straight from the combo's own (deliberately unused) inventory.stockQuantity
// instead of resolving it from its components, even though the single-product
// detail page (getPublicProductBySlug) already did this correctly.

const RUN_ID = Date.now().toString().slice(-6);
const createdProductIds: mongoose.Types.ObjectId[] = [];

async function makeBaseProduct(name: string, stock: number) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `${name} ${RUN_ID}-${n}`,
    slug: `${name.toLowerCase()}-${RUN_ID}-${n}`,
    sku: `BASE-CAT-${RUN_ID}-${n}`,
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

async function makeComboProduct(components: { productId: mongoose.Types.ObjectId; quantity: number }[]) {
  const n = createdProductIds.length;
  const product = await Product.create({
    name: `Navadhanya Combo ${RUN_ID}-${n}`,
    slug: `navadhanya-combo-cat-${RUN_ID}-${n}`,
    sku: `COMBO-CAT-${RUN_ID}-${n}`,
    shortDescription: "Short description.",
    description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 1200, sellingPrice: 1000 },
    // Deliberately 0 — the combo's own counter is unused once tracking is on.
    inventory: { stockQuantity: 0, lowStockThreshold: 5, trackInventory: true },
    seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["combo"] },
    status: "ACTIVE",
    inventoryTracking: { enabled: true, components },
  });
  createdProductIds.push(product._id);
  return product;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await Product.deleteMany({ _id: { $in: createdProductIds } });
  await mongoose.connection.close();
});

describe("Public catalog listing shows a combo's REAL availability, not its own unused stock counter", () => {
  it("GET /api/products (catalog grid) reports in-stock when components have enough stock", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 36);
    const combo = await makeComboProduct([{ productId: navadhanya._id, quantity: 1 }]);

    const res = await request(app).get("/api/products?pageSize=50");
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((i: { productId: string }) => i.productId === combo._id.toString());
    expect(item).toBeTruthy();
    expect(item.inventory.inStock).toBe(true);
    expect(item.inventory.stockQuantity).toBe(36);
  });

  it("GET /api/products (catalog grid) reports out-of-stock when the limiting component is actually empty", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 0);
    const combo = await makeComboProduct([{ productId: navadhanya._id, quantity: 1 }]);

    const res = await request(app).get("/api/products?pageSize=50");
    const item = res.body.data.items.find((i: { productId: string }) => i.productId === combo._id.toString());
    expect(item.inventory.inStock).toBe(false);
  });

  it("GET /api/products/:slug/related also resolves component-based availability", async () => {
    const navadhanya = await makeBaseProduct("Navadhanya", 36);
    const combo = await makeComboProduct([{ productId: navadhanya._id, quantity: 1 }]);
    // A sibling in the same category so it's eligible to appear as "related".
    const sibling = await Product.create({
      name: `Sibling ${RUN_ID}`,
      slug: `sibling-${RUN_ID}`,
      sku: `SIB-${RUN_ID}`,
      shortDescription: "Short description.",
      description: "A longer description of the product.",
      categoryId: combo.categoryId,
      brandId: combo.brandId,
      pricing: { mrp: 120, sellingPrice: 100 },
      inventory: { stockQuantity: 10, lowStockThreshold: 5, trackInventory: true },
      seo: { title: "SEO title here", description: "SEO description here that is long enough.", keywords: ["sibling"] },
      status: "ACTIVE",
    });
    createdProductIds.push(sibling._id);

    const res = await request(app).get(`/api/products/${sibling.slug}/related?limit=8`);
    expect(res.status).toBe(200);
    const item = res.body.data.products.find((p: { productId: string }) => p.productId === combo._id.toString());
    expect(item).toBeTruthy();
    expect(item.inventory.inStock).toBe(true);
    expect(item.inventory.stockQuantity).toBe(36);
  });
});
