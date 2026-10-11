import { env } from '../config/env.js';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';

/** Opens the configured database, applies migrations, runs fn, and always closes. */
export async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const config = env();
  const db = await createDb({
    databaseUrl: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    sslCaFile: config.DATABASE_SSL_CA,
    pgliteDataDir: config.pgliteDataDir,
  });
  try {
    await migrate(db);
    await fn(db);
  } finally {
    await db.close();
  }
}

export function run(fn: () => Promise<void>) {
  fn().catch((err) => {
    console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
