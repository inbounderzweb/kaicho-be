import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { Order } from "../../database/models";
import { refundPayment } from "../../common/payments/razorpay";
import { toOrderDto } from "./order.service";

// Refunds live in their own file rather than order.service.ts because this is
// the only order operation that reaches an external system — it can fail
// halfway (money moved at Razorpay, our write failed) in ways nothing else
// here can, and keeping it separate makes that boundary obvious.

export async function refundOrder(orderId: string, amountRupees?: number) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new AppError("Order not found", 404);
  }
  const doc = await Order.findById(orderId).exec();
  if (!doc) {
    throw new AppError("Order not found", 404);
  }

  const paymentId = doc.payment?.razorpayPaymentId;
  if (!paymentId) {
    throw new AppError(
      doc.paymentMethod === "COD"
        ? "This is a Cash on Delivery order — there is no online payment to refund"
        : "This order has no captured payment to refund",
      409
    );
  }

  if (doc.paymentStatus === "REFUNDED") {
    throw new AppError("This order has already been fully refunded", 409);
  }

  const alreadyRefundedMinor = Math.round((doc.payment?.refundedAmount ?? 0) * 100);
  const grandTotalMinor = Math.round(doc.pricing.grandTotal * 100);
  const requestedMinor = amountRupees ? Math.round(amountRupees * 100) : grandTotalMinor - alreadyRefundedMinor;

  if (requestedMinor <= 0) {
    throw new AppError("Refund amount must be greater than 0", 400);
  }
  if (alreadyRefundedMinor + requestedMinor > grandTotalMinor) {
    throw new AppError("Refund amount exceeds the remaining refundable balance", 400);
  }

  const refund = await refundPayment(paymentId, requestedMinor);

  // Written only after the gateway confirms. If our save fails here the
  // money HAS moved and our record lags — the refund.processed webhook is
  // the backstop that reconciles that case.
  const totalRefundedMinor = alreadyRefundedMinor + requestedMinor;
  doc.payment = { ...(doc.payment ?? {}), refundedAmount: totalRefundedMinor / 100 };
  doc.paymentStatus = totalRefundedMinor >= grandTotalMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
  doc.statusHistory.push({
    status: doc.status,
    at: new Date(),
    note: `Refund of ₹${requestedMinor / 100} processed (${refund.id}, ${refund.status})`,
  });
  await doc.save();

  return toOrderDto(doc);
}
