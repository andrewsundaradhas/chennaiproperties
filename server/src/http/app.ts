import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Env } from '../config/env.js';
import type { Db } from '../db/client.js';
import type { AiProvider } from '../ai/provider.js';
import { RulesProvider } from '../ai/rules.js';
import { adminRoutes } from './routes/admin.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { publicRoutes } from './routes/public.routes.js';
import { cors, errorHandler, notFoundHandler, requestId, securityHeaders } from './middleware/common.js';

export interface AppDeps {
  db: Db;
  env: Env;
  ai: AiProvider;
  fallback?: AiProvider;
}

export function createApp({ db, env, ai, fallback }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);

  app.use(requestId);
  app.use(securityHeaders);
  app.use(cors(env.APP_ORIGIN));
  app.use(express.json({ limit: '2mb' }));

  const deps = {
    db,
    ai,
    fallback: fallback ?? new RulesProvider(),
    interpretTimeoutMs: env.GEMINI_TIMEOUT_MS * 3,
    composeFor: env.GEMINI_COMPOSE,
  };
  app.use('/api', publicRoutes(db));
  app.use('/api/chat', chatRoutes(deps));
  app.use('/api/admin', adminRoutes(db, env));
  app.use('/api', notFoundHandler);

  // In production the API can also serve the built frontend (single deployable).
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  if (env.NODE_ENV === 'production' && fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
