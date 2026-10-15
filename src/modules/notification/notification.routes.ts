import { Router } from "express";
import { requireAuth } from "../../common/middleware/requireAuth";
import { requireRole } from "../../common/middleware/requireRole";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { AppError } from "../../common/errors";
import { User } from "../../database/models";
import { issueNotificationToken, NOTIFICATION_TOKEN_TTL } from "./token";
import { listAdminOrderNotifications, markAdminOrderNotificationsRead } from "./adminNotificationFeed";

const router = Router();
router.use(requireAuth, requireRole("admin"));
router.get("/", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: await listAdminOrderNotifications(req.userId!) });
}));
router.post("/read", asyncHandler(async (req, res) => {
  const orderIds: unknown = req.body?.orderIds;
  if (!Array.isArray(orderIds) || orderIds.length === 0 || orderIds.length > 20
    || orderIds.some((id) => typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id))) {
    throw new AppError("Provide between 1 and 20 valid order IDs", 400);
  }
  await markAdminOrderNotificationsRead(req.userId!, [...new Set(orderIds as string[])]);
  res.json({ success: true, data: { read: true } });
}));
router.post("/token", asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select("role tokenVersion isActive").lean();
  if (!user || !user.isActive || user.role !== "admin") throw new AppError("Forbidden", 403);
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: {
    token: issueNotificationToken(req.userId!, user.tokenVersion),
    expiresIn: NOTIFICATION_TOKEN_TTL,
  } });
}));
export default router;
