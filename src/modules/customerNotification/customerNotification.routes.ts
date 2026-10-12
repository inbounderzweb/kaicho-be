import { Router } from "express";
import { requireAuth } from "../../common/middleware";
import { asyncHandler } from "../../common/utils/asyncHandler";
import { listNotifications, markAllRead } from "./customerNotification.service";

// The caller's OWN notifications only - the user always comes from the
// session; there is no endpoint that takes a user id.
const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, data: await listNotifications(req.userId!) });
  })
);

router.post(
  "/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    await markAllRead(req.userId!);
    res.status(200).json({ success: true, data: { read: true } });
  })
);

export default router;
