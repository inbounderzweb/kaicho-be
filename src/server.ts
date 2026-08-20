import app from "./app";
import { env } from "./config/env";
import { connectDatabase } from "./database/connection";
import { cleanupExpiredTemporaryMedia } from "./modules/media/mediaCleanup";

const MEDIA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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
}

bootstrap();
