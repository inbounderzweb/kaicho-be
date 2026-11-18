import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import {
  anyPageTypeSchema,
  entityPageTypeSchema,
  staticPageTypeSchema,
  type SavePageContentInput,
} from "./seoContent.validation";
import {
  getPageContent,
  listStaticPages,
  listEntities,
  savePageContent,
  getPublicPageContent,
} from "./seoContent.service";

// Route params are upper-snake in the API ("ALL_PRODUCTS"); parse strictly so
// an unknown page type is a 404, never a query.
function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, v: unknown): T {
  const r = schema.safeParse(String(v).toUpperCase());
  if (!r.success) throw new AppError("Unknown page type", 404);
  return r.data as T;
}

export const listPagesHandler = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: { pages: await listStaticPages() } });
});

export const listEntitiesHandler = asyncHandler(async (req: Request, res: Response) => {
  const pageType = parse(entityPageTypeSchema, req.params.pageType);
  const items = await listEntities(pageType, { search: req.query.search });
  res.status(200).json({ success: true, data: { items } });
});

export const getStaticHandler = asyncHandler(async (req: Request, res: Response) => {
  const pageType = parse(staticPageTypeSchema, req.params.pageType);
  res.status(200).json({ success: true, data: { content: await getPageContent(pageType, null) } });
});

export const saveStaticHandler = asyncHandler(async (req: Request, res: Response) => {
  const pageType = parse(staticPageTypeSchema, req.params.pageType);
  const content = await savePageContent(pageType, null, req.body as SavePageContentInput, req.userId);
  res.status(200).json({ success: true, message: "Page content saved", data: { content } });
});

export const getEntityHandler = asyncHandler(async (req: Request, res: Response) => {
  const pageType = parse(entityPageTypeSchema, req.params.pageType);
  res.status(200).json({
    success: true,
    data: { content: await getPageContent(pageType, String(req.params.entityId)) },
  });
});

export const saveEntityHandler = asyncHandler(async (req: Request, res: Response) => {
  const pageType = parse(entityPageTypeSchema, req.params.pageType);
  const content = await savePageContent(
    pageType,
    String(req.params.entityId),
    req.body as SavePageContentInput,
    req.userId
  );
  res.status(200).json({ success: true, message: "Page content saved", data: { content } });
});

// ---- Public ----
export const publicPageContentHandler = asyncHandler(async (req: Request, res: Response) => {
  const pageType = parse(anyPageTypeSchema, req.params.pageType);
  const data = await getPublicPageContent(pageType, typeof req.query.slug === "string" ? req.query.slug : undefined);
  res.status(200).json({ success: true, data });
});
