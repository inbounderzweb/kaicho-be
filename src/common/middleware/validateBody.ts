import { NextFunction, Request, Response } from "express";
import { ZodType } from "zod";
import { AppError } from "../errors";

export function validateBody(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join(", ");
      next(new AppError(message, 400));
      return;
    }
    req.body = result.data;
    next();
  };
}
