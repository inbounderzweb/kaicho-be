import express, { Application } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import routes from "./routes";
import adminRoutes from "./modules/admin/admin.routes";
import { notFound, errorHandler } from "./common/middleware";
import { env } from "./config/env";
import { getMediaRoot } from "./modules/media/media.storage";

const app: Application = express();

app.use(cors({ origin: env.frontendOrigin, credentials: true }));
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

app.use(express.static(path.resolve(__dirname, "../public")));
app.use("/uploads/media", express.static(getMediaRoot()));

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
