import mongoose from "mongoose";
import { env } from "../config/env";

let isConnected = false;

// Fail a query fast instead of the Mongoose default of buffering it for 10s
// while the driver hunts for a reachable node — under load, a brief blip on
// the DB would otherwise pile up thousands of 10-second-hung requests.
mongoose.set("bufferTimeoutMS", 2000);

export async function connectDatabase(): Promise<void> {
  if (isConnected) return;

  await mongoose.connect(env.mongoUri, {
    // Bounded pool per process. With clustering the effective pool is
    // webConcurrency * this — sized in env.ts to stay under the cluster limit.
    maxPoolSize: env.mongoPoolSize,
    minPoolSize: Math.min(2, env.mongoPoolSize),
    // Don't sit for the 30s default deciding the primary is unreachable.
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    // zlib is built into Node — no native addon needed. (zstd/snappy compress
    // better but require extra packages that throw at connect if missing.)
    compressors: ["zlib"],
    zlibCompressionLevel: 6,
  });
  isConnected = true;
  console.log(`MongoDB connected (pool ${env.mongoPoolSize})`);
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
