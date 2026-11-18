import { Router } from "express";
import { publicPageContentHandler } from "./seoContent.controller";

// Unauthenticated storefront read: GET /api/page-content/:pageType[?slug=...]
const router = Router();
router.get("/:pageType", publicPageContentHandler);
export default router;
