import { v2 as cloudinary } from "cloudinary";
import { env } from "../../../config/env";
import type { StorageProvider } from "./types";

// Every asset reaching this provider is already processed by our own pipeline
// (sharp variants, or a PDF as-is — see media.service.ts), so Cloudinary is
// used purely as file storage: everything is uploaded as resource_type "raw",
// which keeps the key (extension included) as the public_id and skips
// Cloudinary's own transformations. That makes getUrl() a pure string build.
export class CloudinaryStorageProvider implements StorageProvider {
  private readonly baseUrl: string;

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
    this.baseUrl = `https://res.cloudinary.com/${env.cloudinaryCloudName}/raw/upload`;
  }

  async upload(key: string, buffer: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: key,
          resource_type: "raw",
          use_filename: false,
          unique_filename: false,
          overwrite: true,
        },
        (err) => (err ? reject(err) : resolve())
      );
      stream.end(buffer);
    });
  }

  async read(key: string): Promise<Buffer> {
    const res = await fetch(this.getUrl(key));
    if (!res.ok) throw new Error(`Cloudinary read failed for "${key}": HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    // "not found" is a successful no-op, matching the other providers.
    await cloudinary.uploader.destroy(key, { resource_type: "raw", invalidate: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await cloudinary.api.resource(key, { resource_type: "raw" });
      return true;
    } catch (err) {
      if ((err as { http_code?: number })?.http_code === 404) return false;
      throw err;
    }
  }

  getUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }
}
