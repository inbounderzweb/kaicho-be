import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { updateOrderStatusSchema, refundOrderSchema } from "./order.validation";
import {
  listAdminOrdersHandler,
  getAdminOrderHandler,
  updateAdminOrderStatusHandler,
  refundAdminOrderHandler,
} from "./adminOrder.controller";

// Admin order management. Unlike the customer routes, orders are addressed by
// Mongo _id here — the admin panel already has the id from the list response
// and never needs to accept a hand-typed order number.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", listAdminOrdersHandler);
router.get("/:id", getAdminOrderHandler);
router.patch("/:id/status", validateBody(updateOrderStatusSchema), updateAdminOrderStatusHandler);
router.post("/:id/refund", validateBody(refundOrderSchema), refundAdminOrderHandler);

export default router;
