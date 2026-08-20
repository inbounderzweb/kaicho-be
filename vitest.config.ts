import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Auth security tests hit the same local dev MongoDB used throughout
    // this project (no mongodb-memory-server) and share OTP rate limits
    // with the running dev server, so they must not run concurrently.
    fileParallelism: false,
  },
});
