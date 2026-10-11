import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { logger } from '../lib/logger.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Anything that can run a parameterised query (the db itself or a transaction). */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a multi-statement SQL script (migrations only; no parameters). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(
    private readonly pg: PGlite,
    private readonly lockFile?: string,
  ) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(sql, params);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }
  async exec(sql: string) {
    await this.pg.exec(sql);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) =>
      fn({
        async query<R>(sql: string, params: unknown[] = []) {
          const res = await tx.query<R>(sql, params);
          return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
        },
        async exec(sql: string) {
          await tx.exec(sql);
        },
      }),
    );
  }
  async close() {
    await this.pg.close();
    if (this.lockFile) fs.rmSync(this.lockFile, { force: true });
  }
}

/**
 * PGlite is single-process: two processes opening the same directory can corrupt it.
 * A pid lockfile makes e.g. `npm run db:seed` fail clearly while the dev server is running.
 */
function acquireLock(dir: string): string {
  const lockFile = path.join(dir, '.cp-process.lock');
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    let alive = false;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(
        `The embedded database at ${dir} is in use by another process (pid ${pid}). ` +
          'Stop the API server (npm run dev) before running database scripts.',
      );
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  return lockFile;
}

class PostgresDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        async query<R>(sql: string, params: unknown[] = []) {
          const res = await client.query(sql, params);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
        },
        async exec(sql: string) {
          await client.query(sql);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

export interface DbOptions {
  databaseUrl?: string;
  ssl?: 'off' | 'require' | 'verify';
  /** Path to a CA certificate (PEM) for ssl = 'verify', e.g. Supabase's root certificate. */
  sslCaFile?: string;
  /** Directory for the embedded database, or 'memory' for an ephemeral one (tests). */
  pgliteDataDir?: string | 'memory';
}

export async function createDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) {
    const url = new URL(opts.databaseUrl);
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    const mode = opts.ssl ?? (isLocal ? 'off' : 'require');
    // sslmode in the URL would override the object below, so TLS is configured only here.
    url.searchParams.delete('sslmode');
    const pool = new pg.Pool({
      connectionString: url.toString(),
      max: 10,
      connectionTimeoutMillis: 10_000,
      ssl:
        mode === 'off'
          ? false
          : mode === 'verify'
            ? { rejectUnauthorized: true, ca: opts.sslCaFile ? fs.readFileSync(opts.sslCaFile, 'utf8') : undefined }
            : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => logger.error('db.pool_error', { message: err.message }));
    return new PostgresDb(pool);
  }
  const dir = opts.pgliteDataDir ?? 'memory';
  if (dir === 'memory') return new PgliteDb(await PGlite.create());
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = acquireLock(dir);
  try {
    return new PgliteDb(await PGlite.create(dir), lockFile);
  } catch (err) {
    fs.rmSync(lockFile, { force: true });
    throw err;
  }
}
