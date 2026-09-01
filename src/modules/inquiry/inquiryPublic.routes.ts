import { Router } from "express";
import { validateBody } from "../../common/middleware";
import { inquirySubmitLimiter } from "../../common/middleware/rateLimiters";
import { submitBulkOrderSchema, submitContactSchema } from "./inquiry.validation";
import { submitBulkOrderHandler, submitContactHandler } from "./inquiry.controller";

// Unauthenticated form submissions. Per-IP rate limited, validated, and the
// response is only the inquiry number — no stored record is ever returned to
// the public.
const router = Router();

router.post("/bulk-order", inquirySubmitLimiter, validateBody(submitBulkOrderSchema), submitBulkOrderHandler);
router.post("/contact", inquirySubmitLimiter, validateBody(submitContactSchema), submitContactHandler);

export default router;
