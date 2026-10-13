import express, { Application } from "express";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import path from "path";
import routes from "./routes";
import adminRoutes from "./modules/admin/admin.routes";
import { notFound, errorHandler } from "./common/middleware";
import { env } from "./config/env";
import { getMediaRoot } from "./modules/media/storage";

const app: Application = express();

// No value to clients, a small header on every response.
app.disable("x-powered-by");
// Behind the Next.js /api rewrite and/or a load balancer, req.ip is the
// proxy's address unless Express is told how many hops to trust - which
// would put every visitor in ONE per-IP rate-limit bucket. Opt-in via
// TRUST_PROXY=<hops>; never `true`, which would let a client spoof its IP
// with its own X-Forwarded-For header.
if (env.trustProxyHops !== undefined) {
  app.set("trust proxy", env.trustProxyHops);
}
// Log every request (method, path, status, response time) so it's obvious
// which endpoint is actually being hit — "dev" locally for a readable
// colored one-liner, "combined" (Apache-style, includes referrer/UA) once
// deployed where logs are typically shipped/grepped rather than eyeballed.
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));
// gzip/brotli every response above ~1KB — JSON catalog payloads compress
// ~5-10x, which is the difference between fast and slow over a tunnel or a
// mobile connection.
app.use(compression());

// Reflect the request's Origin back only when it's on the allow-list. A
// missing Origin (curl, server-to-server, same-origin) is allowed through so
// non-browser callers still work. Anything else is rejected without throwing,
// so the request simply completes without CORS headers.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || env.frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  })
);
// The raw request bytes are stashed on the request so the Razorpay webhook
// can verify its HMAC against exactly what was sent — re-serializing the
// parsed body would change key order/whitespace and break every signature.
// `rawBody` is typed via a declare-global augmentation in the payment module
// (payment.controller.ts), same pattern requireAuth.ts uses for `userId`.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(adminRoutes);

app.use(express.static(path.resolve(__dirname, "../public"), { maxAge: "1h" }));
// Media keys are content-addressed UUIDs that never change once written, so
// they can be cached hard and forever — a repeat image view then costs zero
// bytes and never reaches Node. Only relevant for local disk storage — a
// cloud provider (Cloudflare R2 etc.) serves files from its own public URL and needs
// no route here at all.
if (env.storageProvider === "local") {
  app.use(
    "/uploads/media",
    express.static(getMediaRoot(), { maxAge: "365d", immutable: true })
  );
}

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
