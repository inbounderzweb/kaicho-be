import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import { listOrdersForUser, getOrderForUser, cancelOrderForUser } from "./order.service";
import type { CancelOrderInput } from "./order.validation";

export const listOrdersHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listOrdersForUser(req.userId!, { page, pageSize });
  res.status(200).json({ success: true, data });
});

export const getOrderHandler = asyncHandler(async (req: Request, res: Response) => {
  const order = await getOrderForUser(req.userId!, String(req.params.orderNumber));
  res.status(200).json({ success: true, data: { order } });
});

export const cancelOrderHandler = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body as CancelOrderInput;
  const order = await cancelOrderForUser(req.userId!, String(req.params.orderNumber), reason);
  res.status(200).json({ success: true, message: "Order cancelled", data: { order } });
});
