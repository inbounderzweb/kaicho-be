import { Router } from "express";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { updateUserSchema } from "./adminUsers.validation";
import {
  getUsersStatsHandler,
  getUsersListHandler,
  getUserDetailHandler,
  updateUserHandler,
} from "./adminUsers.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

// /stats must be registered before /:id — otherwise Express would match
// "stats" as an :id value.
router.get("/stats", getUsersStatsHandler);
router.get("/", getUsersListHandler);
router.get("/:id", getUserDetailHandler);
router.patch("/:id", validateBody(updateUserSchema), updateUserHandler);

export default router;
