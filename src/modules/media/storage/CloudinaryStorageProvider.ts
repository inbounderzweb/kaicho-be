import { v2 as cloudinary, type UploadApiErrorResponse } from "cloudinary";
import { env } from "../../../config/env";
import type { StorageProvider } from "./types";

// Every asset that reaches this provider has already been processed by our
// own pipeline (sharp-generated image variants, or a PDF stored as-is — see
// media.service.ts), so Cloudinary is used purely as bucket storage here, not
// as an image-transformation CDN. "raw" resource type stores each key's
// bytes verbatim and serves them back from the exact same public_id, with no
// format-guessing from the dots in the key (image/video resource types would
// otherwise try to interpret the trailing ".webp"/".png" as a transform).
const RESOURCE_TYPE = "raw" as const;

// The Admin API (cloudinary.api.*) rejects with the http_code nested under
// `.error`, not at the top level — unlike the Upload API's callback-style
// errors (UploadApiErrorResponse), which do carry it at the top. Checking
// both shapes keeps this correct regardless of which API produced the error.
function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as Partial<UploadApiErrorResponse> & { error?: { http_code?: number } };
  return candidate.http_code === 404 || candidate.error?.http_code === 404;
}

export class CloudinaryStorageProvider implements StorageProvider {
  constructor() {
    if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
      throw new Error(
        "STORAGE_PROVIDER=cloudinary requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and " +
          "CLOUDINARY_API_SECRET to be set — see .env.example"
      );
    }
    cloudinary.config({
      cloud_name: env.cloudinaryCloudName,
      api_key: env.cloudinaryApiKey,
      api_secret: env.cloudinaryApiSecret,
      secure: true,
    });
  }

  upload(key: string, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { public_id: key, resource_type: RESOURCE_TYPE, overwrite: true },
        (err) => (err ? reject(err) : resolve())
      );
      stream.end(buffer);
    });
  }

  async read(key: string): Promise<Buffer> {
    const res = await fetch(this.getUrl(key));
    if (!res.ok) {
      throw new Error(`Cloudinary read failed for "${key}": HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const result = await cloudinary.uploader.destroy(key, {
      resource_type: RESOURCE_TYPE,
      invalidate: true,
    });
    // Cloudinary resolves (rather than rejects) for an unknown public_id —
    // "not found" is the equivalent of the local provider's ENOENT no-op.
    if (result.result !== "ok" && result.result !== "not found") {
      throw new Error(`Cloudinary delete failed for "${key}": ${result.result}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await cloudinary.api.resource(key, { resource_type: RESOURCE_TYPE });
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  getUrl(key: string): string {
    return cloudinary.url(key, { resource_type: RESOURCE_TYPE, secure: true });
  }
}
