import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { AppError } from "../errors";

export interface SessionPayload {
  sub: string;
  tv: number;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[env.cookieName];

  if (!token) {
    next(new AppError("Not authenticated", 401));
    return;
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret) as SessionPayload;
    req.userId = payload.sub;
    next();
  } catch {
    next(new AppError("Session expired, please log in again", 401));
  }
}
