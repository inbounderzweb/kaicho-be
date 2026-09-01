import { Router } from "express";
import healthRoutes from "../modules/health/health.routes";
import versionRoutes from "../modules/version/version.routes";
import authRoutes from "../modules/auth/auth.routes";
import adminDashboardRoutes from "../modules/adminDashboard/adminDashboard.routes";
import adminUsersRoutes from "../modules/adminDashboard/adminUsers.routes";
import mediaRoutes from "../modules/media/media.routes";
import categoryRoutes from "../modules/category/category.routes";
import collectionRoutes from "../modules/collection/collection.routes";
import brandRoutes from "../modules/brand/brand.routes";
import productRoutes from "../modules/product/product.routes";
import productPublicRoutes from "../modules/product/productPublic.routes";
import categoryPublicRoutes from "../modules/category/categoryPublic.routes";
import collectionPublicRoutes from "../modules/collection/collectionPublic.routes";
import brandPublicRoutes from "../modules/brand/brandPublic.routes";
import wishlistRoutes from "../modules/wishlist/wishlist.routes";
import addressRoutes from "../modules/address/address.routes";
import checkoutRoutes from "../modules/checkout/checkout.routes";
import orderRoutes from "../modules/order/order.routes";
import adminOrderRoutes from "../modules/order/adminOrder.routes";
import paymentRoutes from "../modules/payment/payment.routes";
import adminBlogRoutes from "../modules/blog/blog.routes";
import adminBlogCategoryRoutes from "../modules/blog/blogCategory.routes";
import adminBlogTagRoutes from "../modules/blog/blogTag.routes";
import blogPublicRoutes from "../modules/blog/blogPublic.routes";
import adminInquiryRoutes from "../modules/inquiry/inquiry.routes";
import inquiryPublicRoutes from "../modules/inquiry/inquiryPublic.routes";

const router = Router();

router.use("/health", healthRoutes);
router.use("/version", versionRoutes);
router.use("/auth", authRoutes);
router.use("/admin/users", adminUsersRoutes);
router.use("/admin/media", mediaRoutes);
router.use("/admin/categories", categoryRoutes);
router.use("/admin/collections", collectionRoutes);
router.use("/admin/brands", brandRoutes);
// Mounted before adminDashboardRoutes (which still owns the generic
// "/admin/*" prefix for the dashboard/orders dummy endpoints) so the real
// product routes take precedence over anything adminDashboardRoutes might
// also define at "/products" — see adminDashboard.routes.ts, which no
// longer defines one, but the ordering is what makes that safe either way.
router.use("/admin/products", productRoutes);
// Same ordering rule as /admin/products above: adminDashboardRoutes still
// defines a generic "/orders" of its own, so the real order routes must be
// mounted first to win the match.
router.use("/admin/orders", adminOrderRoutes);
// Same ordering rule as /admin/products and /admin/orders above — mounted
// before the generic "/admin" dashboard router so these win the match.
router.use("/admin/blogs", adminBlogRoutes);
router.use("/admin/blog-categories", adminBlogCategoryRoutes);
router.use("/admin/blog-tags", adminBlogTagRoutes);
router.use("/admin/inquiries", adminInquiryRoutes);
router.use("/admin", adminDashboardRoutes);

// Public, unauthenticated customer-facing catalog routes — separate DTOs
// and route surface from the /admin/* CRUD routes above, sharing the same
// underlying service layer (see product.service.ts's "Public catalog"
// section). Spec §3/§48/§49.
router.use("/products", productPublicRoutes);
router.use("/categories", categoryPublicRoutes);
router.use("/collections", collectionPublicRoutes);
router.use("/brands", brandPublicRoutes);
router.use("/blogs", blogPublicRoutes);
router.use("/inquiries", inquiryPublicRoutes);
// Requires requireAuth per-route (see wishlist.routes.ts) — a logged-in
// user's own wishlist, not part of the unauthenticated catalog surface
// above, but still a "/api/*" (not "/api/admin/*") customer-facing route.
router.use("/wishlist", wishlistRoutes);
// The rest of the logged-in customer surface — address book, checkout, order
// history, and the Razorpay callbacks. Each router applies requireAuth
// itself (see each *.routes.ts), except the Razorpay webhook, which is
// authenticated by HMAC signature instead of a session cookie.
router.use("/addresses", addressRoutes);
router.use("/checkout", checkoutRoutes);
router.use("/orders", orderRoutes);
router.use("/payments", paymentRoutes);

export default router;
