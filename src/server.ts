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

async function bootstrap() {
  await connectDatabase();

  app.listen(env.port, () => {
    console.log(`Kaicho backend running on http://localhost:${env.port}`);
    console.log(`Environment: ${env.nodeEnv}`);
  });

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

bootstrap();
