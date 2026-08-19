import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { env } from "../../config/env";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const providedKey =
    req.header("x-admin-key") ?? (req.query.key as string | undefined);

  if (!providedKey || !safeEqual(providedKey, env.adminKey)) {
    res.status(404).json({
      success: false,
      message: "Not found",
    });
    return;
  }

  next();
}
