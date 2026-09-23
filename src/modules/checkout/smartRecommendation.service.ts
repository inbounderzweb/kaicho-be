import { AppError } from "../../common/errors";
import { Category, Product, type PackConfig, type ProductDocument, type PackRecommendationStrategy } from "../../database/models";
import { resolveLine, type PricedProduct, type RequestedLine } from "./checkout.service";
import { calculateCombinations, getApplicablePacks, resolveEffectivePackConfig } from "../product/packCombination.service";
import { mergeResolvedComponents, type ResolvedComponent } from "../product/inventoryTracking.service";
import { getDefaultPackRecommendationStrategy } from "../settings/settings.service";
import { getPrimaryImageUrlMap } from "../product/product.service";

type SourceProduct = PricedProduct & Pick<ProductDocument, "slug" | "relatedCombo" | "sortOrder" | "shortDescription">;
const fields = "name slug sku status categoryId pricing inventory packConfig inventoryTracking relatedCombo sortOrder shortDescription";
// How many ranked alternatives the recommendation popup can list at once.
// Bounded because each one costs its own stock check + image lookup.
const MAX_RECOMMENDATIONS = 4;
export interface SmartSelection {
  productId: string;
  name: string;
  slug: string;
  shortDescription: string;
  image: string | null;
  mrp: number;
  quantity: number;
  price: number;
  totalPrice: number;
  selectionType: "UNIT" | "PACK";
  packBreakdown?: { packId: string; packName: string; packQuantity: number; packCount: number; packPrice: number }[];
}
interface Context {
  products: Map<string, SourceProduct>;
  categories: Map<string, { packConfig?: PackConfig }>;
  strategy: PackRecommendationStrategy;
}
async function contextFor(ids: string[]): Promise<Context> {
  const docs = await Product.find({ _id: { $in: ids } }).select(fields).lean();
  const categories = await Category.find({ _id: { $in: docs.filter(d => d.packConfig?.mode === "INHERIT_CATEGORY").map(d => d.categoryId) } }).select("packConfig").lean();
  return {
    products: new Map(docs.map(d => [d._id.toString(), d as unknown as SourceProduct])),
    categories: new Map(categories.map(d => [d._id.toString(), d])),
    strategy: await getDefaultPackRecommendationStrategy(),
  };
}
function resolve(context: Context, line: RequestedLine) {
  const product = context.products.get(line.productId);
  if (!product || product.status !== "ACTIVE") throw new AppError("Product is no longer available", 409);
  const result = resolveLine(line, product, context.categories.get(product.categoryId.toString()) ?? null, context.strategy);
  if (!Number.isSafeInteger(result.quantity) || result.quantity <= 0 || !Number.isSafeInteger(Math.round(result.lineTotal * 100)) || result.lineTotal < 0) throw new AppError("Invalid product configuration", 409);
  return result;
}
async function assertStock(requirements: ResolvedComponent[]) {
  const docs = await Product.find({ _id: { $in: requirements.map(c => c.productId) } }).select("status inventory").lean();
  const byId = new Map(docs.map(d => [d._id.toString(), d]));
  for (const line of requirements) {
    const product = byId.get(line.productId);
    if (!product || product.status !== "ACTIVE" || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || (product.inventory.trackInventory && product.inventory.stockQuantity < line.quantity)) throw new AppError("Not enough stock for this selection and the items already in your cart", 409);
  }
}
async function quote(context: Context, line: RequestedLine, cartRequirements: ResolvedComponent[]): Promise<SmartSelection> {
  const result = resolve(context, line);
  await assertStock(mergeResolvedComponents(cartRequirements, result.inventoryRequirement));
  const product = context.products.get(line.productId)!;
  const images = await getPrimaryImageUrlMap([line.productId]);
  return {
    productId: line.productId, name: product.name, slug: product.slug, shortDescription: product.shortDescription,
    image: images.get(line.productId) ?? null,
    mrp: product.pricing.mrp, quantity: result.quantity, price: result.lineTotal / result.quantity,
    totalPrice: result.lineTotal, selectionType: result.selectionType,
    packBreakdown: result.packBreakdown?.map(p => ({ ...p, packId: p.packId.toString() })),
  };
}
export async function validateSmartSelection(line: RequestedLine, cart: RequestedLine[] = []): Promise<SmartSelection> {
  const context = await contextFor([line.productId, ...cart.map(c => c.productId)]);
  const existing = mergeResolvedComponents(...cart.map(c => resolve(context, c).inventoryRequirement));
  return quote(context, line, existing);
}

export interface RankedCandidate {
  line: RequestedLine;
  tier: number;
  quantity: number;
  priority: number;
  price: number;
  key: string;
}
export function rankCandidates(candidates: RankedCandidate[], quantity: number, strategy: PackRecommendationStrategy): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    const tier = a.tier - b.tier;
    if (tier) return tier;
    const distance = Math.abs(a.quantity - quantity) - Math.abs(b.quantity - quantity);
    if (distance) return distance;
    const rule = strategy === "CHEAPEST" ? a.price - b.price : strategy === "LARGEST_FIRST" ? b.quantity - a.quantity : strategy === "SMALLEST_FIRST" ? a.quantity - b.quantity : a.priority - b.priority;
    return rule || a.priority - b.priority || a.price - b.price || a.key.localeCompare(b.key);
  });
}

// One live decision per Add to Cart. Relationships use component IDs, never product names.
export async function recommendSmartSelection(productId: string, quantity: number, cart: RequestedLine[] = []) {
  const context = await contextFor([productId, ...cart.map(c => c.productId)]);
  const existing = mergeResolvedComponents(...cart.map(c => resolve(context, c).inventoryRequirement));
  const current = await quote(context, { productId, quantity }, existing);
  const product = context.products.get(productId)!;
  const effective = resolveEffectivePackConfig(product, context.categories.get(product.categoryId.toString()), context.strategy);
  const strategy = effective?.recommendationStrategy ?? context.strategy;
  const candidates: RankedCandidate[] = [];
  const add = (line: RequestedLine, tier: number, priority: number, relatedUnits?: number) => {
    try {
      const resolved = resolve(context, line);
      candidates.push({ line, tier, priority, quantity: relatedUnits ?? resolved.quantity, price: resolved.lineTotal, key: `${line.productId}:${JSON.stringify(line.packSelection ?? [])}` });
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  };
  const addPacks = (owner: SourceProduct, relatedOnly: boolean) => {
    const config = resolveEffectivePackConfig(owner, context.categories.get(owner.categoryId.toString()), context.strategy);
    if (!config) return;
    const packs = config.packs.filter(p => p.isActive && (!relatedOnly || (p.useComponentInventory && p.inventoryComponents.some(c => c.productId.toString() === productId))));
    for (const pack of packs) {
      if (strategy === "MANUAL_ONLY" && !pack.isDefault) continue;
      const references = pack.useComponentInventory ? pack.inventoryComponents.filter(c => c.productId.toString() === productId).reduce((sum, c) => sum + c.quantity, 0) : pack.quantity;
      if (!references) continue;
      add({ productId: owner._id.toString(), quantity: pack.quantity, packSelection: [{ packId: pack._id.toString(), count: 1 }] }, pack.isDefault ? 1 : relatedOnly ? 5 : config.source === "PRODUCT" ? 2 : 4, pack.sortOrder, references);
    }
    if (!relatedOnly && strategy !== "MANUAL_ONLY") {
      const combination = calculateCombinations(getApplicablePacks(config, quantity), quantity, { mixedPacksAllowed: config.mixedPacksAllowed, strategy });
      if (combination) add({ productId, quantity, packSelection: combination.breakdown.map(p => ({ packId: p.packId, count: p.packCount })) }, config.source === "PRODUCT" ? 2 : 4, 0);
    }
  };
  addPacks(product, false);
  if (product.relatedCombo?.mode !== "NONE") {
    const relatedCategories = await Category.find({ "packConfig.enabled": true, "packConfig.packs.inventoryComponents.productId": productId }).select("packConfig").lean();
    for (const category of relatedCategories) context.categories.set(category._id.toString(), category);
    const related = await Product.find({ status: "ACTIVE", _id: { $ne: productId }, $or: [
      { "inventoryTracking.enabled": true, "inventoryTracking.components.productId": productId },
      { "packConfig.enabled": true, "packConfig.packs.inventoryComponents.productId": productId },
      { "packConfig.enabled": true, "packConfig.mode": "INHERIT_CATEGORY", categoryId: { $in: relatedCategories.map(category => category._id) } },
    ] }).select(fields).lean();
    const missingCategories = related.filter(p => p.packConfig?.mode === "INHERIT_CATEGORY").map(p => p.categoryId);
    if (missingCategories.length) for (const category of await Category.find({ _id: { $in: missingCategories } }).select("packConfig").lean()) context.categories.set(category._id.toString(), category);
    for (const doc of related) {
      const candidate = doc as unknown as SourceProduct;
      const id = doc._id.toString();
      context.products.set(id, candidate);
      const references = candidate.inventoryTracking?.enabled ? candidate.inventoryTracking.components.filter(c => c.productId.toString() === productId).reduce((sum, c) => sum + c.quantity, 0) : 0;
      const pinned = product.relatedCombo?.mode === "MANUAL" && product.relatedCombo.comboProductId?.toString() === id;
      if (references && (pinned || strategy !== "MANUAL_ONLY")) add({ productId: id, quantity: 1 }, pinned ? 0 : 3, candidate.sortOrder ?? 0, references);
      addPacks(candidate, true);
    }
  }
  // Every candidate is quoted against the SAME `existing` cart requirement,
  // never cumulatively — the customer picks at most one of these, so each is
  // priced/stock-checked as if it were the only thing being added.
  // `recommendation` stays the top-ranked one so existing callers (and the
  // tests) keep working; `recommendations` is the list the popup renders.
  const recommendations: SmartSelection[] = [];
  const seen = new Set<string>();
  for (const candidate of rankCandidates(candidates, quantity, strategy)) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    if (seen.has(candidate.key)) continue;
    try {
      recommendations.push(await quote(context, candidate.line, existing));
      seen.add(candidate.key);
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return { current, recommendation: recommendations[0] ?? null, recommendations };
}
