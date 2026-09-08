import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import {
  listCouponsAdmin,
  getCouponAdmin,
  createCouponAdmin,
  updateCouponAdmin,
  setCouponStatusAdmin,
  listCouponUsagesAdmin,
} from "./adminCoupon.service";
import type {
  CouponCreateInput,
  CouponUpdateInput,
  CouponStatusInput,
} from "./adminCoupon.validation";

export const listCouponsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listCouponsAdmin({
    page,
    pageSize,
    search: req.query.search,
    status: req.query.status,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getCouponHandler = asyncHandler(async (req: Request, res: Response) => {
  const coupon = await getCouponAdmin(String(req.params.id));
  res.status(200).json({ success: true, data: { coupon } });
});

export const createCouponHandler = asyncHandler(async (req: Request, res: Response) => {
  const coupon = await createCouponAdmin(req.body as CouponCreateInput, req.userId);
  res.status(201).json({ success: true, message: "Coupon created", data: { coupon } });
});

export const updateCouponHandler = asyncHandler(async (req: Request, res: Response) => {
  const coupon = await updateCouponAdmin(String(req.params.id), req.body as CouponUpdateInput, req.userId);
  res.status(200).json({ success: true, message: "Coupon updated", data: { coupon } });
});

export const setCouponStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status, note } = req.body as CouponStatusInput;
  const coupon = await setCouponStatusAdmin(String(req.params.id), status, req.userId, note);
  res.status(200).json({ success: true, message: `Coupon ${status.toLowerCase()}`, data: { coupon } });
});

export const listCouponUsagesHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listCouponUsagesAdmin(String(req.params.id), { page, pageSize });
  res.status(200).json({ success: true, data });
});
