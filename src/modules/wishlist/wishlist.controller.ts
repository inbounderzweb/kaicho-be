import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import * as wishlistService from "./wishlist.service";

export const getWishlistHandler = asyncHandler(async (req: Request, res: Response) => {
  const wishlist = await wishlistService.getWishlist(req.userId!);
  res.status(200).json({ success: true, data: wishlist });
});

export const addToWishlistHandler = asyncHandler(async (req: Request, res: Response) => {
  await wishlistService.addToWishlist(req.userId!, String(req.params.productId));
  const wishlist = await wishlistService.getWishlist(req.userId!);
  res.status(200).json({ success: true, message: "Added to wishlist", data: wishlist });
});

export const removeFromWishlistHandler = asyncHandler(async (req: Request, res: Response) => {
  await wishlistService.removeFromWishlist(req.userId!, String(req.params.productId));
  const wishlist = await wishlistService.getWishlist(req.userId!);
  res.status(200).json({ success: true, message: "Removed from wishlist", data: wishlist });
});
