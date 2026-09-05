import { env } from "../../../config/env";
import { CloudinaryStorageProvider } from "./CloudinaryStorageProvider";
import { LocalStorageProvider, getMediaRoot } from "./LocalStorageProvider";
import type { StorageProvider } from "./types";

export type { StorageProvider } from "./types";
export { getMediaRoot };

// Single seam every module reaches through — none of them know or care which
// provider is behind it. Switching STORAGE_PROVIDER in .env (see
// .env.example) is the only change needed to move where files live; nothing
// that calls getStorageProvider() changes.
export function getStorageProvider(): StorageProvider {
  switch (env.storageProvider) {
    case "cloudinary":
      return new CloudinaryStorageProvider();
    case "local":
      return new LocalStorageProvider();
    default:
      throw new Error(`Unknown STORAGE_PROVIDER: "${env.storageProvider}" (expected "local" or "cloudinary")`);
  }
}
