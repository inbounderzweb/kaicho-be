import { Router, Request, Response, NextFunction } from "express";
import multer, { MulterError } from "multer";
import { env } from "../../config/env";
import { requireAuth, requireRole, validateBody } from "../../common/middleware";
import { mediaUploadLimiter, mediaDeleteLimiter } from "../../common/middleware/rateLimiters";
import { updateMediaSchema } from "./media.validation";
import {
  uploadMediaHandler,
  getMediaListHandler,
  getMediaDetailHandler,
  getMediaUsagesHandler,
  updateMediaHandler,
  deleteMediaHandler,
} from "./media.controller";

const router = Router();

// Multer only parses multipart/form-data — it doesn't know a file's real
// type yet, so its size cap is the larger of the two per-type limits. The
// precise per-type limit is enforced afterward in media.service.ts, once the
// actual file type has been detected from content.
const multerLimitBytes =
  Math.max(env.maxImageFileSizeMb, env.maxPdfFileSizeMb) * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: multerLimitBytes,
    files: env.maxMediaFilesPerRequest,
  },
});

function handleMulterError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "One or more files exceed the maximum allowed size"
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
          ? `Too many files — maximum is ${env.maxMediaFilesPerRequest} per request`
          : "Failed to parse uploaded files";
    res.status(400).json({ success: false, message });
    return;
  }
  next(err);
}

router.use(requireAuth, requireRole("admin"));

router.post(
  "/upload",
  mediaUploadLimiter,
  upload.array("files", env.maxMediaFilesPerRequest),
  handleMulterError,
  uploadMediaHandler
);

router.get("/", getMediaListHandler);
router.get("/:id/usages", getMediaUsagesHandler);
router.get("/:id", getMediaDetailHandler);
router.patch("/:id", validateBody(updateMediaSchema), updateMediaHandler);
router.delete("/:id", mediaDeleteLimiter, deleteMediaHandler);

export default router;
