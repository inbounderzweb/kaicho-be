import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  createInquiryFromForm,
  listInquiriesAdmin,
  getInquiryAdmin,
  updateInquiryAdmin,
  changeInquiryStatus,
  assignInquiry,
  addInquiryNote,
  deleteInquiryAdmin,
  getInquiryStats,
  listAdminAssignees,
} from "./inquiry.service";
import type {
  SubmitBulkOrderInput,
  SubmitContactInput,
  UpdateInquiryInput,
  ChangeStatusInput,
  AssignInquiryInput,
  AddNoteInput,
} from "./inquiry.validation";

// ---- Public submit ----

export const submitBulkOrderHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await createInquiryFromForm("bulk_order", req.body as SubmitBulkOrderInput);
  res.status(201).json({ success: true, message: "Inquiry submitted", data: result });
});

export const submitContactHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await createInquiryFromForm("contact", req.body as SubmitContactInput);
  res.status(201).json({ success: true, message: "Inquiry submitted", data: result });
});

// ---- Admin ----

export const listInquiriesHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await listInquiriesAdmin({
    page,
    pageSize,
    formType: req.query.formType,
    status: req.query.status,
    assignedTo: req.query.assignedTo,
    search: req.query.search,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    sort: req.query.sort,
  });
  res.status(200).json({ success: true, data });
});

export const getInquiryStatsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const data = await getInquiryStats();
  res.status(200).json({ success: true, data });
});

export const listAssigneesHandler = asyncHandler(async (_req: Request, res: Response) => {
  const data = await listAdminAssignees();
  res.status(200).json({ success: true, data });
});

export const getInquiryHandler = asyncHandler(async (req: Request, res: Response) => {
  const inquiry = await getInquiryAdmin(String(req.params.id));
  if (!inquiry) throw new AppError("Inquiry not found", 404);
  res.status(200).json({ success: true, data: { inquiry } });
});

export const updateInquiryHandler = asyncHandler(async (req: Request, res: Response) => {
  const inquiry = await updateInquiryAdmin(String(req.params.id), req.body as UpdateInquiryInput, req.userId);
  if (!inquiry) throw new AppError("Inquiry not found", 404);
  res.status(200).json({ success: true, message: "Inquiry updated", data: { inquiry } });
});

export const changeInquiryStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as ChangeStatusInput;
  const inquiry = await changeInquiryStatus(String(req.params.id), status, req.userId);
  if (!inquiry) throw new AppError("Inquiry not found", 404);
  res.status(200).json({ success: true, message: "Status updated", data: { inquiry } });
});

export const assignInquiryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { assignedTo } = req.body as AssignInquiryInput;
  const inquiry = await assignInquiry(String(req.params.id), assignedTo ? String(assignedTo) : null, req.userId);
  if (!inquiry) throw new AppError("Inquiry not found", 404);
  res.status(200).json({ success: true, message: "Assignment updated", data: { inquiry } });
});

export const addInquiryNoteHandler = asyncHandler(async (req: Request, res: Response) => {
  const { note } = req.body as AddNoteInput;
  const inquiry = await addInquiryNote(String(req.params.id), req.userId!, note);
  if (!inquiry) throw new AppError("Inquiry not found", 404);
  res.status(201).json({ success: true, message: "Note added", data: { inquiry } });
});

export const deleteInquiryHandler = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await deleteInquiryAdmin(String(req.params.id), req.userId);
  if (deleted === null) throw new AppError("Inquiry not found", 404);
  res.status(200).json({ success: true, message: "Inquiry deleted" });
});
