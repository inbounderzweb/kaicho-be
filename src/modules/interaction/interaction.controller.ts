import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { parsePublicPagination } from "../../common/utils/publicPagination";
import * as service from "./interaction.service";
import { bufferStats } from "./interaction.buffer";

// 202, not 201: ingestion is fire-and-forget from the storefront's view.
export const recordInteractionsHandler = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.recordInteractions(
    req.userId!,
    req.body.events,
    req.interaction?.consent,
    req.interaction?.correlationId
  );
  res.status(202).json({ success: true, data });
});

export const getConsentHandler = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: await service.getTrackingConsent(req.userId!) });
});

export const setConsentHandler = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.setTrackingConsent(req.userId!, req.body.granted);
  res.status(200).json({ success: true, data });
});

export const getHistoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePublicPagination(req);
  res.status(200).json({ success: true, data: await service.getOwnHistory(req.userId!, page, pageSize) });
});

export const deleteDataHandler = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await service.deleteAllForUser(req.userId!);
  res.status(200).json({ success: true, message: "Interaction data deleted", data: { deleted } });
});

// Per-process counters for monitoring (admin-only route).
export const statsHandler = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: bufferStats() });
});
