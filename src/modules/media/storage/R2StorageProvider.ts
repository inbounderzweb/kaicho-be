import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import path from "path";
import { env } from "../../../config/env";
import type { StorageProvider } from "./types";

// Cloudflare R2 is S3-compatible, so the plain S3 client works against its
// account endpoint. Every asset reaching this provider is already processed
// by our own pipeline (sharp variants, or a PDF as-is — see media.service.ts),
// so R2 is used purely as bucket storage. Objects are served to browsers
// directly from R2_PUBLIC_URL (a custom domain or the r2.dev URL), never
// through the API.
const CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly prefix: string;

  constructor() {
    if (
      !env.r2AccountId ||
      !env.r2AccessKeyId ||
      !env.r2SecretAccessKey ||
      !env.r2Bucket ||
      !env.r2PublicUrl
    ) {
      throw new Error(
        "STORAGE_PROVIDER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, " +
          "R2_BUCKET and R2_PUBLIC_URL to be set — see .env.example"
      );
    }
    this.bucket = env.r2Bucket;
    this.publicUrl = env.r2PublicUrl.replace(/\/+$/, "");
    this.prefix = env.r2KeyPrefix ? `${env.r2KeyPrefix}/` : "";
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey,
      },
    });
  }

  // Namespaces every object under development/ or production/ (see env.ts).
  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async upload(key: string, buffer: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Body: buffer,
        ContentType: CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream",
        // Keys are uuid-based and never rewritten, so cache hard.
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  }

  async read(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    if (!res.Body) throw new Error(`R2 read failed for "${key}": empty body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    // S3-style delete is already a no-op for a missing key.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  getUrl(key: string): string {
    return `${this.publicUrl}/${this.k(key)}`;
  }
}
