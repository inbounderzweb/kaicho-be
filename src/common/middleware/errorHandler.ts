import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors";
import { env } from "../../config/env";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const message = err instanceof Error ? err.message : "Internal Server Error";

  if (!isAppError) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(isAppError && err.details !== undefined ? { details: err.details } : {}),
    ...(env.nodeEnv === "development" && err instanceof Error
      ? { stack: err.stack }
      : {}),
  });
}
