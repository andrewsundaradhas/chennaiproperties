import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { createAiProvider } from './ai/index.js';
import { createApp } from './http/app.js';
import { logger } from './lib/logger.js';

async function main() {
  const config = env();
  const db = await createDb({
    databaseUrl: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    sslCaFile: config.DATABASE_SSL_CA,
    pgliteDataDir: config.pgliteDataDir,
  });
  await migrate(db);
  const ai = createAiProvider(config);
  const app = createApp({ db, env: config, ai });

  const server = app.listen(config.PORT, () => {
    logger.info('server.started', {
      port: config.PORT,
      db: db.kind,
      ai: ai.name,
      env: config.NODE_ENV,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info('server.stopping', { signal });
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { message: (reason as Error)?.message });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
