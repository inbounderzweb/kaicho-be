import { Request, Response } from "express";
import { isDatabaseConnected } from "../../database/connection";
import { appInfo } from "../../common/utils";

export function getHealth(_req: Request, res: Response) {
  const dbConnected = isDatabaseConnected();

  res.status(200).json({
    success: true,
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    startedAt: appInfo.startedAt,
    database: dbConnected ? "connected" : "disconnected",
  });
}
