import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { Product } from "../../../database/models";

// The cart page stops "+" at real stock using the server's per-line `stockLimit`.
const RUN_ID = Date.now().toString().slice(-6);
const ids: mongoose.Types.ObjectId[] = [];
let n = 0;
async function make(stock: number, track: boolean) {
  const p = await Product.create({
    name: `StockLimit ${RUN_ID}-${n}`, slug: `stocklimit-${RUN_ID}-${n}`, sku: `SLM-${RUN_ID}-${n++}`,
    shortDescription: "Short description.", description: "A longer description of the product.",
    categoryId: new mongoose.Types.ObjectId(), brandId: new mongoose.Types.ObjectId(),
    pricing: { mrp: 150, sellingPrice: 100 },
    inventory: { stockQuantity: stock, lowStockThreshold: 2, trackInventory: track },
    seo: { title: "SEO title here", description: "SEO description here", keywords: ["x"] }, status: "ACTIVE",
  });
  ids.push(p._id);
  return p._id.toString();
}
const evaluate = (productId: string, quantity: number) =>
  request(app).post("/api/offers/evaluate").send({ items: [{ productId, quantity }] });

beforeAll(async () => { await connectDatabase(); });
afterAll(async () => { await Product.deleteMany({ _id: { $in: ids } }); await mongoose.connection.close(); });

describe("cart stock limit", () => {
  it("reports 45 for a 45-stock product and flags 46 as insufficient", async () => {
    const id = await make(45, true);
    const ok = (await evaluate(id, 45)).body.data.items[0];
    expect(ok).toMatchObject({ stockLimit: 45, insufficientStock: false });
    const over = (await evaluate(id, 46)).body.data.items[0];
    expect(over).toMatchObject({ stockLimit: 45, insufficientStock: true });
  });
  it("is null when stock isn't tracked", async () => {
    const id = await make(0, false);
    expect((await evaluate(id, 500)).body.data.items[0].stockLimit).toBeNull();
  });
});
