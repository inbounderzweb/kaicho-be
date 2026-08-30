import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Collection, CollectionDocument, Media, Product } from "../../database/models";
import { getStorageProvider } from "../media/media.storage";
import { getMediaDocById } from "../media/media.service";
import { slugify } from "../../common/utils/slugify";
import { getProductSummariesByIds } from "../product/product.service";
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  UpdateCollectionProductsInput,
} from "./collection.validation";

const storage = getStorageProvider();
const PUBLIC_PRODUCT_STATUSES = ["ACTIVE", "OUT_OF_STOCK"] as const;

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

function toImageInfo(media: any) {
  if (!media) return null;
  const optimizedKey = media.variants ? media.variants.optimized.key : media.storageKey;
  return {
    mediaId: media._id.toString(),
    url: storage.getUrl(optimizedKey),
    thumbnailUrl: media.variants ? storage.getUrl(media.variants.thumbnail.key) : undefined,
  };
}

async function validateProducts(items: { productId: string; sortOrder: number }[]) {
  const unique = [...new Map(items.map((p) => [p.productId, p])).values()];
  const ids = unique.map((p) => p.productId);
  const docs = await Product.find({ _id: { $in: ids }, status: { $in: [...PUBLIC_PRODUCT_STATUSES] } })
    .select("_id")
    .lean();
  if (docs.length !== ids.length) throw new AppError("One or more products are invalid or unavailable", 400);
  return unique.sort((a, b) => a.sortOrder - b.sortOrder);
}

function shapeCollection(doc: any, media: any, products: any[] = []) {
  return {
    collectionId: doc._id.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description ?? null,
    image: toImageInfo(media),
    isActive: doc.isActive,
    sortOrder: doc.sortOrder,
    productCount: products.length,
    products,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function createCollection(input: CreateCollectionInput) {
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new AppError("Could not derive a valid slug", 400);
  if (await Collection.exists({ $or: [{ name: input.name.trim() }, { slug }] })) {
    throw new AppError("A collection with this name or slug already exists", 409);
  }
  const products = input.products ? await validateProducts(input.products) : [];
  const doc = await Collection.create({
    name: input.name.trim(),
    slug,
    description: input.description?.trim() || undefined,
    imageMediaId: input.imageMediaId || undefined,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    products,
  });
  return getCollectionById(doc._id.toString());
}

export async function updateCollection(id: string, patch: UpdateCollectionInput) {
  if (!isValidObjectId(id)) return null;
  const doc = await Collection.findById(id).exec();
  if (!doc) return null;
  if (patch.name !== undefined) doc.name = patch.name.trim();
  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug);
    if (!slug) throw new AppError("Invalid slug", 400);
    doc.slug = slug;
  }
  if (patch.description !== undefined) doc.description = patch.description?.trim() || undefined;
  if (patch.imageMediaId !== undefined) doc.imageMediaId = patch.imageMediaId || undefined;
  if (patch.isActive !== undefined) doc.isActive = patch.isActive;
  if (patch.sortOrder !== undefined) doc.sortOrder = patch.sortOrder;
  if (patch.products) doc.products = await validateProducts(patch.products);
  await doc.save();
  return getCollectionById(id);
}

export async function updateCollectionProducts(id: string, input: UpdateCollectionProductsInput) {
  if (!isValidObjectId(id)) return null;
  const doc = await Collection.findById(id).exec();
  if (!doc) return null;
  doc.products = await validateProducts(input.products);
  await doc.save();
  return getCollectionById(id);
}

export async function deleteCollection(id: string) {
  if (!isValidObjectId(id)) return null;
  const res = await Collection.findByIdAndDelete(id).exec();
  return Boolean(res);
}

export async function getCollectionById(id: string) {
  if (!isValidObjectId(id)) return null;
  const doc = await Collection.findById(id).lean();
  if (!doc) return null;
  const media = doc.imageMediaId ? await getMediaDocById(doc.imageMediaId.toString()) : null;
  const products = doc.products?.length ? await getProductSummariesByIds(doc.products.map((p: any) => p.productId.toString())) : [];
  const ordered = [...products].sort((a: any, b: any) => {
    const aOrder = doc.products.find((p: any) => p.productId.toString() === a.productId)?.sortOrder ?? 0;
    const bOrder = doc.products.find((p: any) => p.productId.toString() === b.productId)?.sortOrder ?? 0;
    return aOrder - bOrder;
  });
  return shapeCollection(doc, media, ordered);
}

export async function listCollections() {
  const docs = await Collection.find().sort({ sortOrder: 1, updatedAt: -1 }).lean();
  const mediaIds = [...new Set(docs.map((d) => d.imageMediaId?.toString()).filter(Boolean))] as string[];
  const mediaDocs = mediaIds.length ? await Media.find({ _id: { $in: mediaIds } }).exec() : [];
  const mediaMap = new Map(mediaDocs.map((m) => [m._id.toString(), m]));
  return docs.map((doc) => shapeCollection(doc, doc.imageMediaId ? mediaMap.get(doc.imageMediaId.toString()) : null));
}

export async function getActiveCollectionsForHomepage() {
  const docs = await Collection.find({ isActive: true }).sort({ sortOrder: 1, updatedAt: -1 }).lean();
  const mediaIds = [...new Set(docs.map((d) => d.imageMediaId?.toString()).filter(Boolean))] as string[];
  const mediaDocs = mediaIds.length ? await Media.find({ _id: { $in: mediaIds } }).exec() : [];
  const mediaMap = new Map(mediaDocs.map((m) => [m._id.toString(), m]));
  const collections = [];
  for (const doc of docs) {
    const productRefs = doc.products ?? [];
    const products = await getProductSummariesByIds(productRefs.map((p: any) => p.productId.toString()));
    const ordered = products.sort((a: any, b: any) => {
      const ao = productRefs.find((p: any) => p.productId.toString() === a.productId)?.sortOrder ?? 0;
      const bo = productRefs.find((p: any) => p.productId.toString() === b.productId)?.sortOrder ?? 0;
      return ao - bo;
    });
    collections.push(shapeCollection(doc, doc.imageMediaId ? mediaMap.get(doc.imageMediaId.toString()) : null, ordered));
  }
  return collections;
}
