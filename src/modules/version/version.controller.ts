import { Request, Response } from "express";
import { appInfo } from "../../common/utils";
import { env } from "../../config/env";

export function getVersion(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    name: appInfo.name,
    version: appInfo.version,
    environment: env.nodeEnv,
    node: process.version,
  });
}
