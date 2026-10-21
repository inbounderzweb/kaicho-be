import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePagination } from "../adminDashboard/pagination";
import {
  listOffersAdmin,
  getOfferAdmin,
  createOfferAdmin,
  updateOfferAdmin,
  setOfferStatusAdmin,
  listOfferUsagesAdmin,
  simulateOfferAdmin,
} from "./adminOffer.service";
import type {
  OfferCreateInput,
  OfferUpdateInput,
  OfferStatusInput,
  OfferSimulateInput,
} from "./adminOffer.validation";

export const listOffersHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listOffersAdmin({
    page,
    pageSize,
    search: req.query.search,
    status: req.query.status,
    sort: req.query.sort,
    order: req.query.order,
  });
  res.status(200).json({ success: true, data });
});

export const getOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const offer = await getOfferAdmin(String(req.params.id));
  res.status(200).json({ success: true, data: { offer } });
});

export const createOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const offer = await createOfferAdmin(req.body as OfferCreateInput, req.userId);
  res.status(201).json({ success: true, message: "Offer created", data: { offer } });
});

export const updateOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const offer = await updateOfferAdmin(String(req.params.id), req.body as OfferUpdateInput, req.userId);
  res.status(200).json({ success: true, message: "Offer updated", data: { offer } });
});

export const setOfferStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status, note } = req.body as OfferStatusInput;
  const offer = await setOfferStatusAdmin(String(req.params.id), status, req.userId, note);
  res.status(200).json({ success: true, message: `Offer ${offer.status.toLowerCase()}`, data: { offer } });
});

export const simulateOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const data = await simulateOfferAdmin(String(req.params.id), req.body as OfferSimulateInput);
  res.status(200).json({ success: true, data });
});

export const listOfferUsagesHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listOfferUsagesAdmin(String(req.params.id), { page, pageSize });
  res.status(200).json({ success: true, data });
});
