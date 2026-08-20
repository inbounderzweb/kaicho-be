import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { User, Product } from "../../database/models";
import { getProductSummariesByIds } from "../product/product.service";

// Wishlist is deliberately NOT a new collection/module of its own — it's
// built entirely on the existing (until now unused) User.wishlist: string[]
// field per the spec's "reuse what already exists" instruction. No new
// schema, no new indexes beyond what User already has.

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

// Same PUBLIC_STATUSES rule as the rest of the public catalog: a product
// can only be *added* to the wishlist if it's currently customer-visible.
// (Products already in the list that later go DRAFT/ARCHIVED are left in
// the raw User.wishlist array but silently filtered out of the hydrated
// listing by getProductSummariesByIds — not force-removed, so they
// reappear automatically if the product becomes visible again.)
async function assertPubliclyVisibleProduct(productId: string): Promise<void> {
  if (!isValidObjectId(productId)) {
    throw new AppError("Invalid product id", 400);
  }
  const product = await Product.findOne({
    _id: productId,
    status: { $in: ["ACTIVE", "OUT_OF_STOCK"] },
  })
    .select("_id")
    .lean();
  if (!product) {
    throw new AppError("Product not found", 404);
  }
}

export async function getWishlist(userId: string) {
  const user = await User.findById(userId).select("wishlist").lean();
  if (!user) {
    throw new AppError("Not authenticated", 401);
  }
  const items = await getProductSummariesByIds(user.wishlist ?? []);
  return { items, total: items.length };
}

export async function addToWishlist(userId: string, productId: string): Promise<void> {
  await assertPubliclyVisibleProduct(productId);
  // $addToSet: idempotent, no duplicate-check round trip needed.
  await User.updateOne({ _id: userId }, { $addToSet: { wishlist: productId } });
}

export async function removeFromWishlist(userId: string, productId: string): Promise<void> {
  if (!isValidObjectId(productId)) {
    throw new AppError("Invalid product id", 400);
  }
  await User.updateOne({ _id: userId }, { $pull: { wishlist: productId } });
}
