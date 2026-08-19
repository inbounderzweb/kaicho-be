import { Request, Response } from "express";
import { appInfo } from "../../common/utils";
import { env } from "../../config/env";
import { isDatabaseConnected } from "../../database/connection";

const ENDPOINTS = [
  { method: "GET", path: "/", description: "Status dashboard (UI)" },
  { method: "GET", path: "/api/health", description: "Service health & uptime" },
  { method: "GET", path: "/api/version", description: "App name, version & environment" },
  { method: "GET", path: "/admin@124", description: "Admin: list of all endpoints" },
];

export function getAdminList(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    name: appInfo.name,
    version: appInfo.version,
    environment: env.nodeEnv,
    uptime: process.uptime(),
    database: isDatabaseConnected() ? "connected" : "disconnected",
    endpoints: ENDPOINTS,
  });
}
