import { Router } from "express";
import { validateBody, popupEventLimiter } from "../../common/middleware";
import { popupEventSchema } from "./popup.validation";
import { listLivePopupsHandler, recordPopupEventHandler } from "./popup.controller";

// Unauthenticated storefront surface.
const router = Router();

router.get("/", listLivePopupsHandler);
router.post("/:id/events", popupEventLimiter, validateBody(popupEventSchema), recordPopupEventHandler);

export default router;
