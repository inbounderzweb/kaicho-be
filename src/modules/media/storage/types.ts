// Keys are always generated server-side (uuid + date, see media.service.ts) —
// never taken from client input. Every provider must treat `key` as an
// opaque, already-safe identifier.
export interface StorageProvider {
  upload(key: string, buffer: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getUrl(key: string): string;
}
