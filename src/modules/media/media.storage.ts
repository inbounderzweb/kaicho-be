import fs from "fs/promises";
import path from "path";
import { env } from "../../config/env";

export interface StorageProvider {
  upload(key: string, buffer: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getUrl(key: string): string;
}

const MEDIA_ROOT = path.resolve(process.cwd(), env.mediaBasePath);
const PUBLIC_MOUNT = "/uploads/media";

// Keys are always generated server-side (uuid + date, see media.service.ts) —
// never taken from client input — so this is defense in depth, not the
// primary guarantee against path traversal.
function resolveSafePath(key: string): string {
  const full = path.resolve(MEDIA_ROOT, key);
  if (!full.startsWith(MEDIA_ROOT + path.sep)) {
    throw new Error(`Refusing to resolve storage key outside media root: ${key}`);
  }
  return full;
}

export class LocalStorageProvider implements StorageProvider {
  async upload(key: string, buffer: Buffer): Promise<void> {
    const filePath = resolveSafePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  async delete(key: string): Promise<void> {
    const filePath = resolveSafePath(key);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(resolveSafePath(key));
      return true;
    } catch {
      return false;
    }
  }

  getUrl(key: string): string {
    return `${PUBLIC_MOUNT}/${key}`;
  }
}

export function getStorageProvider(): StorageProvider {
  return new LocalStorageProvider();
}

export function getMediaRoot(): string {
  return MEDIA_ROOT;
}
