import app from "./app";
import { env } from "./config/env";
import { connectDatabase } from "./database/connection";

async function bootstrap() {
  await connectDatabase();

  app.listen(env.port, () => {
    console.log(`Kaicho backend running on http://localhost:${env.port}`);
    console.log(`Environment: ${env.nodeEnv}`);
  });
}

bootstrap();
