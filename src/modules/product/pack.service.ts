import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Product, ProductDocument, Pack } from "../../database/models";
import { computePackDiscount, computePackAvailability } from "./packCombination.service";
import { assertAndConsolidateComponents } from "./inventoryTracking.service";
import type { CreatePackInput, UpdatePackInput, UpdatePackConfigInput } from "./pack.validation";

// Product.packConfig.packs is a Mongoose subdocument array — every mutation
// here is an atomic $push / positional $set / $pull on the Product document,
// the same pattern address.service.ts uses for User.addresses, so two
// concurrent pack edits on the same product can't clobber each other's whole
// array (see PackConfig.schema.ts's header comment).

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

export interface PackDto {
  packId: string;
  name: string;
  quantity: number;
  price: number;
  sku?: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  /** Derived — see PackConfig.schema.ts's header comment. Never stored. */
  discount: number;
  discountPercentage: number;
  /** Derived from the base product's real stock (or, when useComponentInventory is set, from its components) — never a second counter. */
  availableStock: number;
  useComponentInventory: boolean;
  inventoryComponents: { productId: string; quantity: number }[];
}

function toPackDto(pack: Pack, productMrp: number, productStock: number): PackDto {
  const { discount, discountPercentage } = computePackDiscount(pack, productMrp);
  return {
    packId: pack._id.toString(),
    name: pack.name,
    quantity: pack.quantity,
    price: pack.price,
    sku: pack.sku,
    isActive: pack.isActive,
    isDefault: pack.isDefault,
    sortOrder: pack.sortOrder,
    discount,
    discountPercentage,
    // The admin list doesn't batch-load component stock (that's the public
    // DTO's job, product.service.ts#getPublicProductBySlug) — this is just
    // the single-product fallback figure either way, good enough for the
    // admin table's read-only "Available" column.
    availableStock: computePackAvailability(pack, productStock),
    useComponentInventory: pack.useComponentInventory,
    inventoryComponents: pack.inventoryComponents.map((c) => ({ productId: c.productId.toString(), quantity: c.quantity })),
  };
}

async function getProductOrThrow(productId: string): Promise<ProductDocument> {
  if (!isValidObjectId(productId)) {
    throw new AppError("Product not found", 404);
  }
  const product = await Product.findById(productId).exec();
  if (!product) {
    throw new AppError("Product not found", 404);
  }
  return product;
}

export async function listPacks(productId: string): Promise<PackDto[]> {
  const product = await getProductOrThrow(productId);
  const packs = product.packConfig?.packs ?? [];
  return [...packs]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((p) => toPackDto(p, product.pricing.mrp, product.inventory.stockQuantity));
}

// SKU uniqueness is scoped to this product's own pack list, not global — a
// pack isn't a separately sellable catalog SKU the way Product.sku is, it's
// a priced bundle of an existing one.
function assertSkuAvailable(packs: Pack[], sku: string | undefined, excludePackId?: string): void {
  if (!sku) return;
  const clash = packs.some((p) => p.sku === sku && p._id.toString() !== excludePackId);
  if (clash) {
    throw new AppError(`A pack with SKU "${sku}" already exists on this product`, 409);
  }
}

export async function createPack(productId: string, input: CreatePackInput): Promise<PackDto> {
  const product = await getProductOrThrow(productId);
  const existingPacks = product.packConfig?.packs ?? [];
  assertSkuAvailable(existingPacks, input.sku);

  const inventoryComponents = await assertAndConsolidateComponents(input.inventoryComponents);

  const packId = new mongoose.Types.ObjectId();
  const subdoc = {
    _id: packId,
    name: input.name,
    quantity: input.quantity,
    price: input.price,
    sku: input.sku,
    isActive: input.isActive ?? true,
    isDefault: input.isDefault ?? false,
    sortOrder: input.sortOrder ?? existingPacks.length,
    useComponentInventory: input.useComponentInventory ?? false,
    inventoryComponents,
  };

  if (subdoc.isDefault) {
    await Product.updateOne(
      { _id: productId },
      { $set: { "packConfig.packs.$[].isDefault": false } }
    );
  }

  // `packConfig` may not exist yet on a product enabling packs for the first
  // time — $push auto-vivifies the array (and Mongoose fills in the rest of
  // packConfig's schema defaults on next read/save), so no separate
  // "create packConfig" step is needed.
  const result = await Product.updateOne(
    { _id: productId },
    { $push: { "packConfig.packs": subdoc } }
  );
  if (result.matchedCount === 0) {
    throw new AppError("Product not found", 404);
  }

  const fresh = await getProductOrThrow(productId);
  return toPackDto(subdoc as unknown as Pack, fresh.pricing.mrp, fresh.inventory.stockQuantity);
}

export async function updatePack(productId: string, packId: string, patch: UpdatePackInput): Promise<PackDto> {
  if (!isValidObjectId(packId)) {
    throw new AppError("Pack not found", 404);
  }
  const product = await getProductOrThrow(productId);
  const packs = product.packConfig?.packs ?? [];
  const target = packs.find((p) => p._id.toString() === packId);
  if (!target) {
    throw new AppError("Pack not found", 404);
  }

  if (patch.sku !== undefined) {
    assertSkuAvailable(packs, patch.sku, packId);
  }

  if (patch.isDefault === true) {
    await Product.updateOne(
      { _id: productId },
      { $set: { "packConfig.packs.$[].isDefault": false } }
    );
  }

  const $set: Record<string, unknown> = {};
  for (const key of ["name", "quantity", "price", "sku", "isActive", "isDefault", "sortOrder", "useComponentInventory"] as const) {
    if (patch[key] !== undefined) {
      $set[`packConfig.packs.$.${key}`] = patch[key];
    }
  }
  if (patch.inventoryComponents !== undefined) {
    $set["packConfig.packs.$.inventoryComponents"] = await assertAndConsolidateComponents(patch.inventoryComponents);
  }

  const result = await Product.updateOne(
    { _id: productId, "packConfig.packs._id": packId },
    { $set }
  );
  if (result.matchedCount === 0) {
    throw new AppError("Pack not found", 404);
  }

  const fresh = await getProductOrThrow(productId);
  const updated = fresh.packConfig?.packs.find((p) => p._id.toString() === packId);
  if (!updated) {
    throw new AppError("Pack not found", 404);
  }
  return toPackDto(updated, fresh.pricing.mrp, fresh.inventory.stockQuantity);
}

// Deleting a pack never touches historical orders — an order snapshots the
// pack name/qty/price into OrderItem.packBreakdown at purchase time (see
// Order.model.ts), so there is nothing left in a past order that references
// this row (spec §20/decision #9).
export async function deletePack(productId: string, packId: string): Promise<void> {
  if (!isValidObjectId(packId)) {
    throw new AppError("Pack not found", 404);
  }
  const result = await Product.updateOne(
    { _id: productId },
    { $pull: { "packConfig.packs": { _id: packId } } }
  );
  if (result.matchedCount === 0) {
    throw new AppError("Product not found", 404);
  }
}

export interface PackConfigSettingsDto {
  enabled: boolean;
  mode: "CUSTOM" | "INHERIT_CATEGORY";
  mixedPacksAllowed: boolean;
  recommendationStrategy: string;
}

export async function getPackConfigSettings(productId: string): Promise<PackConfigSettingsDto> {
  const product = await getProductOrThrow(productId);
  const config = product.packConfig;
  return {
    enabled: config?.enabled ?? false,
    mode: config?.mode ?? "CUSTOM",
    mixedPacksAllowed: config?.mixedPacksAllowed ?? true,
    recommendationStrategy: config?.recommendationStrategy ?? "ADMIN_PRIORITY",
  };
}

// Uses the same in-place Object.assign pattern product.service.ts#updateProductById
// uses for `pricing`/`inventory` — packConfig is a single-nested subdocument
// here (unlike `packs`, which is an array), so partial writes work the same
// way. `packConfig` may not exist yet; Mongoose auto-vivifies it as soon as
// any field is assigned (unlike `default: undefined`'s "don't vivify on
// read" behaviour, an explicit assignment on the loaded document does create
// it — exactly what "enabling packs for the first time" needs to do).
export async function updatePackConfigSettings(
  productId: string,
  patch: UpdatePackConfigInput
): Promise<PackConfigSettingsDto> {
  const product = await getProductOrThrow(productId);
  if (!product.packConfig) {
    product.packConfig = {
      enabled: false,
      mode: "CUSTOM",
      mixedPacksAllowed: true,
      recommendationStrategy: "ADMIN_PRIORITY",
      packs: [],
    } as unknown as ProductDocument["packConfig"];
  }
  Object.assign(product.packConfig!, patch);
  await product.save();
  return getPackConfigSettings(productId);
}
