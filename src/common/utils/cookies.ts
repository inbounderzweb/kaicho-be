import { Response } from "express";
import { env } from "../../config/env";

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSameSite,
    domain: env.cookieDomain,
    path: "/",
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(env.cookieName, token, {
    ...cookieOptions(),
    maxAge: env.cookieMaxAgeDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.cookieName, cookieOptions());
}
