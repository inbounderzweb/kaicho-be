import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors";
import { User, UserRole } from "../../database/models";

declare global {
  namespace Express {
    interface Request {
      userRole?: UserRole;
    }
  }
}

// Must run after requireAuth — it depends on req.userId already being set.
export function requireRole(...allowedRoles: UserRole[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = await User.findById(req.userId).exec();
      if (!user || !allowedRoles.includes(user.role)) {
        throw new AppError("Forbidden", 403);
      }
      req.userRole = user.role;
      next();
    } catch (err) {
      next(err instanceof AppError ? err : new AppError("Forbidden", 403));
    }
  };
}
