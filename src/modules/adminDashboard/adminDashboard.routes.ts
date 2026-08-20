import { Router } from "express";
import { requireAuth, requireRole } from "../../common/middleware";
import { getDashboard, getOrdersList } from "./adminDashboard.controller";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/dashboard", getDashboard);
router.get("/orders", getOrdersList);

export default router;
