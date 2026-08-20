import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { AppError } from "../errors";
import { User } from "../../database/models";

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

// Deliberately the same message for every rejection reason (unknown token,
// expired, disabled account, or a token issued before the user's last
// logout/tokenVersion bump) so a caller can't use the response to enumerate
// account status.
const SESSION_INVALID_MESSAGE = "Session expired, please log in again";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[env.cookieName];

  if (!token) {
    next(new AppError("Not authenticated", 401));
    return;
  }

  let payload: SessionPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as SessionPayload;
  } catch {
    next(new AppError(SESSION_INVALID_MESSAGE, 401));
    return;
  }

  // Stateless JWT verification only proves the token was validly issued at
  // some point — it says nothing about whether that session has since been
  // logged out, the account disabled, or the token superseded. This lookup
  // is what makes revocation real instead of cosmetic.
  const user = await User.findById(payload.sub).select("tokenVersion isActive").lean();

  if (!user || !user.isActive || user.tokenVersion !== payload.tv) {
    next(new AppError(SESSION_INVALID_MESSAGE, 401));
    return;
  }

  req.userId = payload.sub;
  next();
}
