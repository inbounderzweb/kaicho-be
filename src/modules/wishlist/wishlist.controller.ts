import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import * as wishlistService from "./wishlist.service";
import { interactionTrackingService } from "../interaction/interaction.tracking.service";

export const getWishlistHandler = asyncHandler(async (req: Request, res: Response) => {
  const wishlist = await wishlistService.getWishlist(req.userId!);
  res.status(200).json({ success: true, data: wishlist });
});

export const addToWishlistHandler = asyncHandler(async (req: Request, res: Response) => {
  const productId = String(req.params.productId);
  const changed = await wishlistService.addToWishlist(req.userId!, productId);
  // Recorded after the business outcome, never awaited, never throws.
  if (changed && req.interaction) {
    void interactionTrackingService.track(req.interaction, { type: "wishlist_add", productId });
  }
  const wishlist = await wishlistService.getWishlist(req.userId!);
  res.status(200).json({ success: true, message: "Added to wishlist", data: wishlist });
});

export const removeFromWishlistHandler = asyncHandler(async (req: Request, res: Response) => {
  const productId = String(req.params.productId);
  const changed = await wishlistService.removeFromWishlist(req.userId!, productId);
  if (changed && req.interaction) {
    void interactionTrackingService.track(req.interaction, { type: "wishlist_remove", productId });
  }
  const wishlist = await wishlistService.getWishlist(req.userId!);
  res.status(200).json({ success: true, message: "Removed from wishlist", data: wishlist });
});
