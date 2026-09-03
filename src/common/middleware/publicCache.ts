import { RequestHandler } from "express";
import { env } from "../../config/env";

// Marks safe (GET/HEAD) responses on the public catalog routes as cacheable
// so a CDN, the browser, and the frontend's Data Cache can serve repeat hits
// without waking the app or Mongo. `stale-while-revalidate` lets a cache keep
// serving the old copy for a few minutes while it refreshes in the
// background, so a burst of traffic never all lands on the origin at once.
//
// Only public, unauthenticated routers get this (see routes/index.ts). The
// errorHandler resets Cache-Control to `no-store`, so a failed request is
// never cached even though this ran first.
export const publicCache: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    res.set(
      "Cache-Control",
      `public, max-age=${env.publicCacheMaxAge}, stale-while-revalidate=300`
    );
  }
  next();
};
