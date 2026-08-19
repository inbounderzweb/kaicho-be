import { NextFunction, Request, Response } from "express";
import { appInfo } from "../utils";

export function notFound(_req: Request, res: Response, _next: NextFunction) {
  res.status(200).json({
    success: true,
    message: `${appInfo.name} version ${appInfo.version}`,
    version: appInfo.version,
  });
}
