import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "./pagination";
import { getUsersList, getUsersStats, getUserById, updateUserById } from "./adminUsers.service";
import type { UpdateUserBody } from "./adminUsers.validation";

export const getUsersStatsHandler = asyncHandler(async (req: Request, res: Response) => {
  const stats = await getUsersStats(req.userId!);
  res.status(200).json({ success: true, data: stats });
});

export const getUsersListHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req);
  const data = await getUsersList({
    page,
    pageSize,
    excludeUserId: req.userId!,
    sortBy: req.query.sortBy,
    sortOrder: req.query.sortOrder,
    search: req.query.search,
    status: req.query.status,
    role: req.query.role,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  });
  res.status(200).json({ success: true, data });
});

export const getUserDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = await getUserById(String(req.params.id), req.userId!);
  if (!user) {
    throw new AppError("User not found", 404);
  }
  res.status(200).json({ success: true, data: { user } });
});

export const updateUserHandler = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateUserBody;
  const user = await updateUserById(String(req.params.id), req.userId!, patch);
  if (!user) {
    throw new AppError("User not found", 404);
  }
  res.status(200).json({ success: true, message: "User updated", data: { user } });
});
