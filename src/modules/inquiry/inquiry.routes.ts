import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import {
  updateInquirySchema,
  changeStatusSchema,
  assignInquirySchema,
  addNoteSchema,
} from "./inquiry.validation";
import {
  listInquiriesHandler,
  getInquiryStatsHandler,
  listAssigneesHandler,
  getInquiryHandler,
  updateInquiryHandler,
  changeInquiryStatusHandler,
  assignInquiryHandler,
  addInquiryNoteHandler,
  deleteInquiryHandler,
} from "./inquiry.controller";

// Admin inquiry management. Mounted at /admin/inquiries behind requireAuth +
// requireRole("admin"). No public reads exist for inquiries.
const router = Router();

router.use(requireAuth, requireRole("admin"));

// Static segments before "/:id".
router.get("/", listInquiriesHandler);
router.get("/stats", getInquiryStatsHandler);
router.get("/assignees", listAssigneesHandler);
router.get("/:id", getInquiryHandler);
router.patch("/:id", validateBody(updateInquirySchema), updateInquiryHandler);
router.delete("/:id", deleteInquiryHandler);
router.post("/:id/status", validateBody(changeStatusSchema), changeInquiryStatusHandler);
router.post("/:id/assign", validateBody(assignInquirySchema), assignInquiryHandler);
router.post("/:id/notes", validateBody(addNoteSchema), addInquiryNoteHandler);

export default router;
