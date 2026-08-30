import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { parsePagination } from "../adminDashboard/pagination";
import {
  createCollection,
  deleteCollection,
  getActiveCollectionsForHomepage,
  getCollectionById,
  listCollections,
  updateCollection,
  updateCollectionProducts,
} from "./collection.service";
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  UpdateCollectionProductsInput,
} from "./collection.validation";

export const createCollectionHandler = asyncHandler(async (req: Request, res: Response) => {
  const collection = await createCollection(req.body as CreateCollectionInput);
  res.status(201).json({ success: true, message: "Collection created", data: { collection } });
});

export const getCollectionListHandler = asyncHandler(async (_req: Request, res: Response) => {
  const collections = await listCollections();
  res.status(200).json({ success: true, data: { collections } });
});

export const getCollectionDetailHandler = asyncHandler(async (req: Request, res: Response) => {
  const collection = await getCollectionById(String(req.params.id));
  if (!collection) throw new AppError("Collection not found", 404);
  res.status(200).json({ success: true, data: { collection } });
});

export const updateCollectionHandler = asyncHandler(async (req: Request, res: Response) => {
  const collection = await updateCollection(String(req.params.id), req.body as UpdateCollectionInput);
  if (!collection) throw new AppError("Collection not found", 404);
  res.status(200).json({ success: true, message: "Collection updated", data: { collection } });
});

export const updateCollectionProductsHandler = asyncHandler(async (req: Request, res: Response) => {
  const collection = await updateCollectionProducts(String(req.params.id), req.body as UpdateCollectionProductsInput);
  if (!collection) throw new AppError("Collection not found", 404);
  res.status(200).json({ success: true, message: "Products updated", data: { collection } });
});

export const deleteCollectionHandler = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await deleteCollection(String(req.params.id));
  if (deleted === null) throw new AppError("Collection not found", 404);
  res.status(200).json({ success: true, message: "Collection deleted" });
});

export const getHomepageCollectionsHandler = asyncHandler(async (_req: Request, res: Response) => {
  const collections = await getActiveCollectionsForHomepage();
  res.status(200).json({ success: true, data: { collections } });
});
