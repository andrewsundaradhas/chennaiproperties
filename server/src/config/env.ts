import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:5173')),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['gemini', 'rules']).optional()),
  GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  GEMINI_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  // Gemini 3.x models "think" by default, which adds seconds per turn. 'none' omits the setting.
  GEMINI_THINKING_LEVEL: z.preprocess(emptyToUndefined, z.enum(['low', 'high', 'none']).default('low')),
  // When to let the model rephrase the grounded draft: only for Tamil/mixed messages (default),
  // always, or never. English drafts are already readable, so this halves model calls.
  GEMINI_COMPOSE: z.preprocess(emptyToUndefined, z.enum(['non_english', 'always', 'never']).default('non_english')),

  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  PGLITE_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('./data/pgdata')),
  // TLS for DATABASE_URL. Default: 'require' for remote hosts, 'off' for localhost.
  // 'require' encrypts without verifying the CA; 'verify' also verifies it (set DATABASE_SSL_CA).
  DATABASE_SSL: z.preprocess(emptyToUndefined, z.enum(['off', 'require', 'verify']).optional()),
  DATABASE_SSL_CA: z.preprocess(emptyToUndefined, z.string().optional()),
  // Connections per process. Serverless (Vercel) runs many small instances, so keep it low there.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),
  // Serverless functions skip migrations at cold start; run `npm run db:migrate` before deploying.
  MIGRATE_ON_START: z.preprocess((v) => (typeof v === 'string' ? v === 'true' : v), z.boolean().optional()),
  // Public https origin of the deployed site, e.g. https://chennai-properties.vercel.app.
  // Used for Telegram photo URLs. Defaults to Vercel's production URL when deployed there.
  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  // Telegram (optional). Without a token the bot is simply disabled.
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().optional()),
  TELEGRAM_MODE: z.preprocess(emptyToUndefined, z.enum(['polling', 'webhook', 'off']).optional()),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, 'use 16-256 letters, digits, _ or -').optional()),
  TELEGRAM_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),

  ADMIN_BOOTSTRAP_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  COOKIE_SECURE: z.preprocess(
    (v) => (typeof v === 'string' ? v === 'true' : v),
    z.boolean().default(false),
  ),
});

export type Env = z.infer<typeof EnvSchema> & {
  aiProvider: 'gemini' | 'rules';
  pgliteDataDir: string;
  /** True when running as a Vercel serverless function. */
  serverless: boolean;
  dbPoolMax: number;
  publicBaseUrl: string | undefined;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const aiProvider = env.AI_PROVIDER ?? (env.GEMINI_API_KEY ? 'gemini' : 'rules');
  if (aiProvider === 'gemini' && (!env.GEMINI_API_KEY || !env.GEMINI_MODEL)) {
    throw new Error(
      'Invalid environment configuration:\n  - AI_PROVIDER=gemini requires GEMINI_API_KEY and GEMINI_MODEL',
    );
  }
  const serverless = Boolean(source.VERCEL);
  const vercelUrl = source.VERCEL_PROJECT_PRODUCTION_URL ? `https://${source.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;
  if (serverless && !env.DATABASE_URL) {
    throw new Error(
      'Invalid environment configuration:\n  - DATABASE_URL is required on Vercel (the embedded database cannot run on serverless). Use the Supabase transaction pooler URL (port 6543).',
    );
  }
  return {
    ...env,
    APP_ORIGIN: source.APP_ORIGIN ? env.APP_ORIGIN : (vercelUrl ?? env.APP_ORIGIN),
    TELEGRAM_MODE: env.TELEGRAM_MODE ?? (serverless && env.TELEGRAM_BOT_TOKEN ? 'webhook' : undefined),
    aiProvider,
    pgliteDataDir: path.resolve(serverRoot, env.PGLITE_DATA_DIR),
    serverless,
    dbPoolMax: env.DB_POOL_MAX ?? (serverless ? 2 : 10),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? vercelUrl)?.replace(/\/$/, ''),
  };
}

let cached: Env | undefined;
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
