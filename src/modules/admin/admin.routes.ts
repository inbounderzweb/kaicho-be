import { Router } from "express";
import { getAdminList } from "./admin.controller";
import { requireAdminKey } from "../../common/middleware/requireAdminKey";

const router = Router();

router.get("/admin@124", requireAdminKey, getAdminList);

export default router;
