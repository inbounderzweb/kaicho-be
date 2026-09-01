import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  updateOrderStatusSchema,
  refundOrderSchema,
  saveShipmentSchema,
  updateShipmentStatusSchema,
} from "./order.validation";
import {
  listAdminOrdersHandler,
  getAdminOrderHandler,
  updateAdminOrderStatusHandler,
  refundAdminOrderHandler,
  saveAdminOrderShipmentHandler,
  updateAdminOrderShipmentStatusHandler,
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
router.put("/:id/shipment", validateBody(saveShipmentSchema), saveAdminOrderShipmentHandler);
router.patch(
  "/:id/shipment/status",
  validateBody(updateShipmentStatusSchema),
  updateAdminOrderShipmentStatusHandler
);

export default router;
