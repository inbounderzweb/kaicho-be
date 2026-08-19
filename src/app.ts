import express, { Application } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import routes from "./routes";
import adminRoutes from "./modules/admin/admin.routes";
import { notFound, errorHandler } from "./common/middleware";
import { env } from "./config/env";

const app: Application = express();

app.use(cors({ origin: env.frontendOrigin, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(adminRoutes);

app.use(express.static(path.resolve(__dirname, "../public")));

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
