import { beforeAll, afterAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Product, Category } from "../../../database/models";
import { recommendSmartSelection, validateSmartSelection } from "../smartRecommendation.service";
import { updateRelatedComboSettings } from "../../product/product.service";

const ids: mongoose.Types.ObjectId[] = [];
let categoryId: mongoose.Types.ObjectId;
async function make(name: string, extra: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId(); ids.push(_id);
  return Product.create({ _id, name, slug: `test-${_id}`, sku: `TEST-${_id}`, shortDescription: "test", description: "test", categoryId,
    brandId: new mongoose.Types.ObjectId(), pricing: { mrp: 150, sellingPrice: 100 }, inventory: { stockQuantity: 10000, trackInventory: true },
    seo: { title: "Testing product title", description: "Testing product description with enough characters", keywords: ["test"] }, status: "ACTIVE", ...extra });
}
const pack = (quantity: number, price: number, extra = {}) => ({ _id: new mongoose.Types.ObjectId(), name: `Pack of ${quantity}`, quantity, price, isActive: true, isDefault: false, sortOrder: 0, useComponentInventory: false, inventoryComponents: [], ...extra });
const config = (packs: ReturnType<typeof pack>[], extra = {}) => ({ enabled: true, mode: "CUSTOM", mixedPacksAllowed: true, recommendationStrategy: "ADMIN_PRIORITY", packs, ...extra });
beforeAll(async () => {
  const uri = process.env.MONGO_URI || "";
  if (!uri.startsWith("mongodb://127.0.0.1:27017/kaicho_smart_test")) throw new Error("Use an isolated local kaicho_smart_test database");
  await mongoose.connect(uri);
  categoryId = (await Category.create({ name: "Smart test", slug: `smart-${Date.now()}`, isActive: true }))._id;
});
afterAll(async () => { await Product.deleteMany({ _id: { $in: ids } }); await Category.deleteOne({ _id: categoryId }); await mongoose.disconnect(); });
describe("live smart recommendations", () => {
  it("does not prompt for an ordinary product or unrelated combo", async () => {
    const p = await make("Ordinary"); const other = await make("Unrelated");
    await make("Other Combo", { inventoryTracking: { enabled: true, components: [{ productId: other._id, quantity: 2 }] } });
    expect((await recommendSmartSelection(p.id, 1)).recommendation).toBeNull();
  });
  it("offers a larger configured pack for one unit without replacing the current selection", async () => {
    const p = await make("Pack Product", { packConfig: config([pack(5, 450)]) });
    const result = await recommendSmartSelection(p.id, 1);
    expect(result.current.quantity).toBe(1); expect(result.current.totalPrice).toBe(100);
    expect(result.recommendation?.quantity).toBe(5); expect(result.recommendation?.totalPrice).toBe(450);
  });
  it("respects the default pack ahead of an exact automatic match", async () => {
    const p = await make("Default Product", { packConfig: config([pack(5, 450, { isDefault: true }), pack(10, 850)]) });
    expect((await recommendSmartSelection(p.id, 10)).recommendation?.quantity).toBe(5);
  });
  it.each([5, 10, 20, 25, 30, 50, 100, 500, 1000])("represents %i exactly when possible", async quantity => {
    const p = await make("Bulk Product", { packConfig: config([pack(5, 450), pack(10, 850), pack(20, 1600)]) });
    const result = await recommendSmartSelection(p.id, quantity);
    expect(result.recommendation?.quantity).toBe(quantity);
    if (quantity === 50) expect(result.recommendation?.totalPrice).toBe(4050);
  });
  it("filters inactive and unfulfillable packs", async () => {
    const p = await make("No available pack", { inventory: { stockQuantity: 3, trackInventory: true }, packConfig: config([pack(5, 450), pack(2, 150, { isActive: false })]) });
    expect((await recommendSmartSelection(p.id, 1)).recommendation).toBeNull();
  });
  it("validates all combo components, even when the virtual parent has zero stock", async () => {
    const p = await make("Component"); const missing = await make("Empty", { inventory: { stockQuantity: 0, trackInventory: true } });
    await make("Sold out combo", { sortOrder: 0, inventoryTracking: { enabled: true, components: [{ productId: p._id, quantity: 1 }, { productId: missing._id, quantity: 1 }] } });
    const available = await make("Available combo", { sortOrder: 1, inventory: { stockQuantity: 0, trackInventory: true }, inventoryTracking: { enabled: true, components: [{ productId: p._id, quantity: 2 }] } });
    expect((await recommendSmartSelection(p.id, 1)).recommendation?.productId).toBe(available.id);
  });
  it("honors a related manual combo before automatic packs", async () => {
    const p = await make("Pinned component", { packConfig: config([pack(5, 450, { isDefault: true })]) });
    const combo = await make("Pinned combo", { inventoryTracking: { enabled: true, components: [{ productId: p._id, quantity: 2 }] } });
    await updateRelatedComboSettings(p.id, { mode: "MANUAL", comboProductId: combo.id });
    expect((await recommendSmartSelection(p.id, 1)).recommendation?.productId).toBe(combo.id);
  });
  it("rejects unrelated manual targets", async () => {
    const p = await make("Pinned source"); const unrelated = await make("Unrelated target");
    await expect(updateRelatedComboSettings(p.id, { mode: "MANUAL", comboProductId: unrelated.id })).rejects.toThrow(/include this product/);
  });
  it("resolves inherited category packs", async () => {
    await Category.updateOne({ _id: categoryId }, { $set: { packConfig: config([pack(5, 420)]) } });
    const p = await make("Inherited", { packConfig: config([], { mode: "INHERIT_CATEGORY" }) });
    expect((await recommendSmartSelection(p.id, 1)).recommendation?.totalPrice).toBe(420);
  });
  it("discovers component packs inherited by another product", async () => {
    const source = await make("Category component source");
    const inheritedPack = pack(5, 430, { useComponentInventory: true, inventoryComponents: [{ productId: source._id, quantity: 5 }] });
    await Category.updateOne({ _id: categoryId }, { $set: { packConfig: config([inheritedPack]) } });
    const owner = await make("Inherited related pack", { packConfig: config([], { mode: "INHERIT_CATEGORY" }) });
    const result = await recommendSmartSelection(source.id, 1);
    expect(result.recommendation?.packBreakdown?.[0].packId).toBe(inheritedPack._id.toString());
    expect(result.recommendation?.totalPrice).toBe(430);
    expect(result.recommendation?.productId).not.toBe(source.id);
    expect(owner).toBeDefined();
  });
  it("revalidates prices and shared inventory on confirmation", async () => {
    const option = pack(5, 450); const p = await make("Revalidate", { inventory: { stockQuantity: 6, trackInventory: true }, packConfig: config([option]) });
    const line = { productId: p.id, quantity: 5, packSelection: [{ packId: option._id.toString(), count: 1 }] };
    await expect(validateSmartSelection(line, [{ productId: p.id, quantity: 2 }])).rejects.toThrow(/stock/);
    await Product.updateOne({ _id: p._id }, { $set: { "packConfig.packs.0.price": 475 } });
    expect((await validateSmartSelection(line)).totalPrice).toBe(475);
  });
  it("manual-only suppresses automatic options but keeps explicit defaults", async () => {
    const p = await make("Manual packs", { packConfig: config([pack(5, 450)], { recommendationStrategy: "MANUAL_ONLY" }) });
    expect((await recommendSmartSelection(p.id, 1)).recommendation).toBeNull();
    await Product.updateOne({ _id: p._id }, { $set: { "packConfig.packs.0.isDefault": true } });
    expect((await recommendSmartSelection(p.id, 1)).recommendation?.quantity).toBe(5);
  });
});
