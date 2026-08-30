import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import { listOrdersAdmin, getOrderAdmin, updateOrderStatusAdmin } from "./order.service";
import { refundOrder } from "./adminOrder.service";
import type { UpdateOrderStatusInput, RefundOrderInput } from "./order.validation";

export const listAdminOrdersHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listOrdersAdmin({
    page,
    pageSize,
    status: req.query.status,
    paymentStatus: req.query.paymentStatus,
    search: req.query.search,
  });
  res.status(200).json({ success: true, data });
});

export const getAdminOrderHandler = asyncHandler(async (req: Request, res: Response) => {
  const order = await getOrderAdmin(String(req.params.id));
  res.status(200).json({ success: true, data: { order } });
});

export const updateAdminOrderStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status, note } = req.body as UpdateOrderStatusInput;
  const order = await updateOrderStatusAdmin(String(req.params.id), req.userId, status, note);
  res.status(200).json({ success: true, message: "Order status updated", data: { order } });
});

export const refundAdminOrderHandler = asyncHandler(async (req: Request, res: Response) => {
  const { amount } = req.body as RefundOrderInput;
  const order = await refundOrder(String(req.params.id), amount);
  res.status(200).json({ success: true, message: "Refund processed", data: { order } });
});
