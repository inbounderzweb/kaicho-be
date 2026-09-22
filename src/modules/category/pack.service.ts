import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Category, CategoryDocument, Pack } from "../../database/models";
import { assertAndConsolidateComponents } from "../product/inventoryTracking.service";
import type { CreatePackInput, UpdatePackInput, UpdateCategoryPackConfigInput } from "../product/pack.validation";

// Same atomic $push / positional $set / $pull pattern as
// product/pack.service.ts (which itself mirrors address.service.ts) —
// category-level packs are the exact same embedded-subdocument shape, just
// on Category.packConfig.packs instead of Product.packConfig.packs, per
// spec §15/§16's "same configuration, different owner" model. Discount and
// stock-availability aren't computed here (unlike the product-scoped DTO) —
// a category has no MRP or stock of its own; those are only meaningful once
// a product inherits this config (see packCombination.service.ts).

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

export interface CategoryPackDto {
  packId: string;
  name: string;
  quantity: number;
  price: number;
  sku?: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  useComponentInventory: boolean;
  inventoryComponents: { productId: string; quantity: number }[];
}

function toDto(pack: Pack): CategoryPackDto {
  return {
    packId: pack._id.toString(),
    name: pack.name,
    quantity: pack.quantity,
    price: pack.price,
    sku: pack.sku,
    isActive: pack.isActive,
    isDefault: pack.isDefault,
    sortOrder: pack.sortOrder,
    useComponentInventory: pack.useComponentInventory,
    inventoryComponents: pack.inventoryComponents.map((c) => ({ productId: c.productId.toString(), quantity: c.quantity })),
  };
}

async function getCategoryOrThrow(categoryId: string): Promise<CategoryDocument> {
  if (!isValidObjectId(categoryId)) {
    throw new AppError("Category not found", 404);
  }
  const category = await Category.findById(categoryId).exec();
  if (!category) {
    throw new AppError("Category not found", 404);
  }
  return category;
}

export async function listCategoryPacks(categoryId: string): Promise<CategoryPackDto[]> {
  const category = await getCategoryOrThrow(categoryId);
  const packs = category.packConfig?.packs ?? [];
  return [...packs].sort((a, b) => a.sortOrder - b.sortOrder).map(toDto);
}

function assertSkuAvailable(packs: Pack[], sku: string | undefined, excludePackId?: string): void {
  if (!sku) return;
  const clash = packs.some((p) => p.sku === sku && p._id.toString() !== excludePackId);
  if (clash) {
    throw new AppError(`A pack with SKU "${sku}" already exists on this category`, 409);
  }
}

export async function createCategoryPack(categoryId: string, input: CreatePackInput): Promise<CategoryPackDto> {
  const category = await getCategoryOrThrow(categoryId);
  const existingPacks = category.packConfig?.packs ?? [];
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
    await Category.updateOne(
      { _id: categoryId },
      { $set: { "packConfig.packs.$[].isDefault": false } }
    );
  }

  const result = await Category.updateOne(
    { _id: categoryId },
    { $push: { "packConfig.packs": subdoc } }
  );
  if (result.matchedCount === 0) {
    throw new AppError("Category not found", 404);
  }

  return toDto(subdoc as unknown as Pack);
}

export async function updateCategoryPack(
  categoryId: string,
  packId: string,
  patch: UpdatePackInput
): Promise<CategoryPackDto> {
  if (!isValidObjectId(packId)) {
    throw new AppError("Pack not found", 404);
  }
  const category = await getCategoryOrThrow(categoryId);
  const packs = category.packConfig?.packs ?? [];
  const target = packs.find((p) => p._id.toString() === packId);
  if (!target) {
    throw new AppError("Pack not found", 404);
  }

  if (patch.sku !== undefined) {
    assertSkuAvailable(packs, patch.sku, packId);
  }

  if (patch.isDefault === true) {
    await Category.updateOne(
      { _id: categoryId },
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

  const result = await Category.updateOne(
    { _id: categoryId, "packConfig.packs._id": packId },
    { $set }
  );
  if (result.matchedCount === 0) {
    throw new AppError("Pack not found", 404);
  }

  const fresh = await getCategoryOrThrow(categoryId);
  const updated = fresh.packConfig?.packs.find((p) => p._id.toString() === packId);
  if (!updated) {
    throw new AppError("Pack not found", 404);
  }
  return toDto(updated);
}

export async function deleteCategoryPack(categoryId: string, packId: string): Promise<void> {
  if (!isValidObjectId(packId)) {
    throw new AppError("Pack not found", 404);
  }
  const result = await Category.updateOne(
    { _id: categoryId },
    { $pull: { "packConfig.packs": { _id: packId } } }
  );
  if (result.matchedCount === 0) {
    throw new AppError("Category not found", 404);
  }
}

export interface CategoryPackConfigDto {
  enabled: boolean;
  mixedPacksAllowed: boolean;
  recommendationStrategy: string;
}

export async function getCategoryPackConfigSettings(categoryId: string): Promise<CategoryPackConfigDto> {
  const category = await getCategoryOrThrow(categoryId);
  const config = category.packConfig;
  return {
    enabled: config?.enabled ?? false,
    mixedPacksAllowed: config?.mixedPacksAllowed ?? true,
    recommendationStrategy: config?.recommendationStrategy ?? "ADMIN_PRIORITY",
  };
}

export async function updateCategoryPackConfigSettings(
  categoryId: string,
  patch: UpdateCategoryPackConfigInput
): Promise<CategoryPackConfigDto> {
  const category = await getCategoryOrThrow(categoryId);
  if (!category.packConfig) {
    category.packConfig = {
      enabled: false,
      mixedPacksAllowed: true,
      recommendationStrategy: "ADMIN_PRIORITY",
      packs: [],
    } as unknown as CategoryDocument["packConfig"];
  }
  Object.assign(category.packConfig!, patch);
  await category.save();
  return getCategoryPackConfigSettings(categoryId);
}
