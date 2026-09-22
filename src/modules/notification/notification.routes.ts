import { Router } from "express";
import { requireAuth } from "../../common/middleware/requireAuth";
import { requireRole } from "../../common/middleware/requireRole";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { User } from "../../database/models";
import { issueNotificationToken, NOTIFICATION_TOKEN_TTL } from "./token";

const router = Router();
router.post("/token", requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select("role tokenVersion isActive").lean();
  if (!user || !user.isActive || user.role !== "admin") throw new AppError("Forbidden", 403);
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: {
    token: issueNotificationToken(req.userId!, user.tokenVersion),
    expiresIn: NOTIFICATION_TOKEN_TTL,
  } });
}));
export default router;
