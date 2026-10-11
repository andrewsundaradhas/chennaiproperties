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

  ADMIN_BOOTSTRAP_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  COOKIE_SECURE: z.preprocess(
    (v) => (typeof v === 'string' ? v === 'true' : v),
    z.boolean().default(false),
  ),
});

export type Env = z.infer<typeof EnvSchema> & {
  aiProvider: 'gemini' | 'rules';
  pgliteDataDir: string;
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
  return {
    ...env,
    aiProvider,
    pgliteDataDir: path.resolve(serverRoot, env.PGLITE_DATA_DIR),
  };
}

let cached: Env | undefined;
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
