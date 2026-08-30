import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { previewCheckout, createCheckout } from "./checkout.service";
import type { CheckoutPreviewInput, CreateCheckoutInput } from "./checkout.validation";

export const previewCheckoutHandler = asyncHandler(async (req: Request, res: Response) => {
  const data = await previewCheckout(req.body as CheckoutPreviewInput);
  res.status(200).json({ success: true, data });
});

export const createCheckoutHandler = asyncHandler(async (req: Request, res: Response) => {
  // Required, not optional: without a key a network-retried submit would
  // place a second order and decrement stock twice, and the client is the
  // only party that can tell a retry apart from a genuine second order.
  const raw = req.get("Idempotency-Key");
  const idempotencyKey = typeof raw === "string" ? raw.trim() : "";
  if (!idempotencyKey) {
    throw new AppError("Idempotency-Key header is required", 400);
  }
  if (idempotencyKey.length > 128) {
    throw new AppError("Idempotency-Key header is too long", 400);
  }

  const { order, razorpayOrder, replayed } = await createCheckout(
    req.userId!,
    req.body as CreateCheckoutInput,
    idempotencyKey
  );

  // 200 on a replay, 201 only when this request is what actually created the
  // order — so a client can tell "your retry found the existing order" from
  // "a new order was placed".
  res.status(replayed ? 200 : 201).json({
    success: true,
    message: replayed ? "Order already placed" : "Order placed",
    data: { order, razorpayOrder },
  });
});
