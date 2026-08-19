import { Router } from "express";
import healthRoutes from "../modules/health/health.routes";
import versionRoutes from "../modules/version/version.routes";
import authRoutes from "../modules/auth/auth.routes";

const router = Router();

router.use("/health", healthRoutes);
router.use("/version", versionRoutes);
router.use("/auth", authRoutes);

export default router;
