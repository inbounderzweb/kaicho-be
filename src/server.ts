import cluster from "node:cluster";
import os from "node:os";
import app from "./app";
import { env } from "./config/env";
import { connectDatabase } from "./database/connection";
import { cleanupExpiredTemporaryMedia } from "./modules/media/mediaCleanup";
import { cancelStalePendingOrders } from "./modules/order/orderCleanup";
import { publishDueScheduledBlogs } from "./modules/blog/blogScheduler";

const MEDIA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// More frequent than the media sweep because what's being held is stock, not
// disk — every minute an abandoned checkout stays open is a minute another
// customer can't buy that unit.
const ORDER_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
// A scheduled post going live a minute late is directly visible to readers, so
// this runs on the tightest interval of the three.
const BLOG_SCHEDULE_INTERVAL_MS = 60 * 1000;

// The background jobs must run in exactly ONE process, never once per worker —
// otherwise N workers all race to cancel the same stale orders / publish the
// same posts. With clustering they run in the primary; single-process they
// run inline.
function startBackgroundJobs() {
  setInterval(() => {
    cleanupExpiredTemporaryMedia().catch((err) => {
      console.error("Media cleanup job failed:", err);
    });
  }, MEDIA_CLEANUP_INTERVAL_MS);

  setInterval(() => {
    cancelStalePendingOrders().catch((err) => {
      console.error("Order cleanup job failed:", err);
    });
  }, ORDER_CLEANUP_INTERVAL_MS);

  setInterval(() => {
    publishDueScheduledBlogs().catch((err) => {
      console.error("Scheduled-blog publish job failed:", err);
    });
  }, BLOG_SCHEDULE_INTERVAL_MS);
}

async function startHttpServer() {
  await connectDatabase();
  app.listen(env.port, () => {
    const who = cluster.isWorker ? `worker ${process.pid}` : "server";
    console.log(`Kaicho backend ${who} listening on http://localhost:${env.port}`);
  });
}

async function bootstrap() {
  const workers = Math.max(1, Math.min(env.webConcurrency, os.cpus().length));

  // Single-process mode (dev default, or WEB_CONCURRENCY=1).
  if (workers === 1) {
    await startHttpServer();
    startBackgroundJobs();
    console.log(`Environment: ${env.nodeEnv}`);
    return;
  }

  // Clustered mode. The primary owns the background jobs and forks the HTTP
  // workers; the OS load-balances incoming connections across them.
  if (cluster.isPrimary) {
    console.log(`Primary ${process.pid} starting ${workers} workers (env: ${env.nodeEnv})`);
    await connectDatabase();
    startBackgroundJobs();
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on("exit", (worker, code) => {
      console.error(`Worker ${worker.process.pid} died (code ${code}) — respawning`);
      cluster.fork();
    });
    return;
  }

  await startHttpServer();
}

bootstrap().catch((err) => {
  console.error("Fatal: failed to start —", err instanceof Error ? err.message : err);
  process.exit(1);
});
