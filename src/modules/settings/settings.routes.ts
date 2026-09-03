import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { updateStoreSettingsSchema } from "./settings.validation";
import { getStoreSettingsHandler, updateStoreSettingsHandler } from "./settings.controller";

// Admin CRUD for the single store-settings document. Mounted at
// /admin/settings (see routes/index.ts), ahead of the generic "/admin"
// dashboard router so it wins the match — same ordering rule as
// /admin/products, /admin/orders, /admin/blogs.
const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/", getStoreSettingsHandler);
router.patch("/", validateBody(updateStoreSettingsSchema), updateStoreSettingsHandler);

export default router;
