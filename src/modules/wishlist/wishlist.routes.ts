import { Router } from "express";
import { requireAuth } from "../../common/middleware";
import {
  getWishlistHandler,
  addToWishlistHandler,
  removeFromWishlistHandler,
} from "./wishlist.controller";

// All wishlist routes require a logged-in user — there is no concept of an
// anonymous/guest wishlist in this app (unlike the cart, which is
// client-side/local per spec's existing-cart-module instruction).
const router = Router();

router.get("/", requireAuth, getWishlistHandler);
router.post("/:productId", requireAuth, addToWishlistHandler);
router.delete("/:productId", requireAuth, removeFromWishlistHandler);

export default router;
