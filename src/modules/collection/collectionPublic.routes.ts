import { Router } from "express";
import { getHomepageCollectionsHandler } from "./collection.controller";

const router = Router();

router.get("/active", getHomepageCollectionsHandler);

export default router;
