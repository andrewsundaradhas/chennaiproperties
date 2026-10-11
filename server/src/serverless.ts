// Vercel serverless entry. The Express app (and its DB pool) is created once per warm instance
// and reused across requests. Long polling never runs here: Telegram uses the webhook route.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { createAiProvider } from './ai/index.js';
import { conversationDeps, createApp } from './http/app.js';
import { setupTelegram } from './channels/telegram/index.js';
import { logger } from './lib/logger.js';

let appPromise: Promise<Express> | null = null;

async function build(): Promise<Express> {
  const config = env();
  const db = await createDb({
    databaseUrl: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    sslCaFile: config.DATABASE_SSL_CA,
    poolMax: config.dbPoolMax,
    pgliteDataDir: config.pgliteDataDir,
  });
  if (config.MIGRATE_ON_START) await migrate(db);
  const ai = createAiProvider(config);
  const telegram = setupTelegram({ db, env: config, conversation: conversationDeps(config, db, ai) });
  const tg = telegram.status();
  if (tg.state === 'disabled') logger.warn('telegram.disabled', { reason: tg.reason });
  else void telegram.start(); // getMe once per cold start; webhook requests also wait for it
  logger.info('serverless.cold_start', { db: db.kind, ai: ai.name, telegram: config.TELEGRAM_MODE ?? 'off' });
  return createApp({ db, env: config, ai, telegram });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  appPromise ??= build().catch((err) => {
    appPromise = null; // retry on the next request instead of caching the failure
    throw err;
  });
  let app: Express;
  try {
    app = await appPromise;
  } catch (err) {
    logger.error('serverless.init_failed', { message: (err as Error)?.message?.split('\n')[0] });
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'unavailable', message: 'Service is starting or misconfigured. Please try again shortly.' } }));
    return;
  }
  app(req as Parameters<Express>[0], res as Parameters<Express>[1]);
}
