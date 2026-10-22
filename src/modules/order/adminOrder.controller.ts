import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import { listOrdersAdmin, getOrderAdmin, updateOrderStatusAdmin, resendOrderStatusEmailAdmin } from "./order.service";
import { refundOrder } from "./adminOrder.service";
import { saveShipment, updateShipmentStatus } from "./shipment.service";
import type {
  UpdateOrderStatusInput,
  RefundOrderInput,
  SaveShipmentInput,
  UpdateShipmentStatusInput,
} from "./order.validation";

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
  const { status, note, sendEmail } = req.body as UpdateOrderStatusInput;
  const order = await updateOrderStatusAdmin(String(req.params.id), req.userId, status, note, sendEmail);
  res.status(200).json({ success: true, message: "Order status updated", data: { order } });
});

export const refundAdminOrderHandler = asyncHandler(async (req: Request, res: Response) => {
  const { amount } = req.body as RefundOrderInput;
  const order = await refundOrder(String(req.params.id), amount);
  res.status(200).json({ success: true, message: "Refund processed", data: { order } });
});

export const saveAdminOrderShipmentHandler = asyncHandler(async (req: Request, res: Response) => {
  const { sendEmail, ...input } = req.body as SaveShipmentInput;
  const order = await saveShipment(String(req.params.id), req.userId, input, sendEmail);
  res.status(200).json({ success: true, message: "Shipping details saved", data: { order } });
});

export const updateAdminOrderShipmentStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, note, sendEmail } = req.body as UpdateShipmentStatusInput;
    const order = await updateShipmentStatus(String(req.params.id), req.userId, status, note, sendEmail);
    res.status(200).json({ success: true, message: "Shipping status updated", data: { order } });
  }
);

export const resendAdminOrderStatusEmailHandler = asyncHandler(async (req: Request, res: Response) => {
  const order = await resendOrderStatusEmailAdmin(String(req.params.id));
  res.status(200).json({ success: true, message: "Email notification processed", data: { order } });
});
