import { Router } from "express";
import { requireAuth, validateBody, paymentVerifyLimiter } from "../../common/middleware";
import { cancelOrderSchema } from "./order.validation";
import { listOrdersHandler, getOrderHandler, cancelOrderHandler, retryOrderPaymentHandler } from "./order.controller";

// Customer-facing order history. Orders are addressed by orderNumber (the
// value the customer actually sees on their confirmation), never by Mongo
// _id — and every service call filters on req.userId as well, so a guessed
// order number belonging to someone else returns 404, not their order.
const router = Router();

router.use(requireAuth);

router.get("/", listOrdersHandler);
router.get("/:orderNumber", getOrderHandler);
// Pay again for an abandoned / failed online payment on a still-pending order.
// Same limiter as payment verification: it can hit the gateway API.
router.post("/:orderNumber/pay", paymentVerifyLimiter, retryOrderPaymentHandler);
router.post("/:orderNumber/cancel", validateBody(cancelOrderSchema), cancelOrderHandler);

export default router;
