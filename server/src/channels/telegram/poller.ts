// Long-polling runner for local development (no public URL needed). Guarantees:
//  - the token is validated (getMe) before polling; an invalid token disables the bot, not the app
//  - at most one consumer per bot: a DB lease, plus Telegram's own 409 Conflict as a backstop
//  - the update offset is persisted, and processed updates are de-duplicated by update_id
//  - stop() aborts the long poll, waits for in-flight updates and releases the lease
import crypto from 'node:crypto';
import os from 'node:os';
import type { Db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { TelegramApiError, type TelegramClient, type TgUpdate, type TgUser } from './api.js';
import type { TelegramBot } from './bot.js';

export type TelegramStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'starting' }
  | { state: 'running'; username: string; mode: 'polling' | 'webhook' }
  | { state: 'waiting_for_lease'; username: string }
  | { state: 'error'; reason: string };

const LEASE_SECONDS = 60;
const LONG_POLL_SECONDS = 25;

export const BOT_COMMANDS = [
  { command: 'start', description: 'Welcome and main menu' },
  { command: 'properties', description: 'Start a property search' },
  { command: 'help', description: 'How to search and what I can do' },
  { command: 'reset', description: 'Start a fresh search' },
  { command: 'cancel', description: 'Cancel the current step' },
];

export class TelegramPoller {
  status: TelegramStatus = { state: 'starting' };
  private readonly owner = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      client: TelegramClient;
      /** Built once the bot id is known (from getMe). */
      makeBot: (me: TgUser) => TelegramBot;
      backoffMs?: (attempt: number) => number;
    },
  ) {}

  /**
   * Validates the token and starts polling in the background. Never throws. A rejected token is
   * final; network problems (offline, Telegram down, Mac just woke up) are retried until they pass.
   */
  async start(): Promise<TelegramStatus> {
    const { client } = this.deps;
    let me: TgUser | null = null;
    for (let attempt = 1; !me && !this.abort.signal.aborted; attempt++) {
      try {
        me = await client.call<TgUser>('getMe', {}, { retries: 2, signal: this.abort.signal });
      } catch (err) {
        if (err instanceof TelegramApiError && err.isUnauthorized) {
          this.status = { state: 'disabled', reason: 'TELEGRAM_BOT_TOKEN was rejected by Telegram (invalid or revoked). Get a new token from @BotFather.' };
          logger.error('telegram.start_failed', { reason: this.status.reason });
          return this.status;
        }
        this.status = { state: 'error', reason: 'Cannot reach Telegram yet (network). Retrying automatically.' };
        if (attempt === 1 || attempt % 10 === 0) logger.warn('telegram.start_retry', { attempt });
        await sleep(this.deps.backoffMs?.(attempt) ?? Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5)), this.abort.signal);
      }
    }
    if (!me) return this.status;
    const username = me.username ?? String(me.id);
    try {
      const info = await client.call<{ url?: string }>('getWebhookInfo');
      if (info.url) {
        this.status = { state: 'disabled', reason: `A webhook is configured for @${username}; long polling is not possible. Remove it with: npm run telegram:webhook -- --delete` };
        logger.error('telegram.webhook_active', { username });
        return this.status;
      }
      await client.call('setMyCommands', { commands: BOT_COMMANDS }).catch(() => undefined);
    } catch {
      // non-fatal
    }
    const bot = this.deps.makeBot(me);
    this.loop = this.supervise(bot, String(me.id), username);
    return this.status;
  }

  /** Restarts the polling loop after any unexpected error, until stop() is called. */
  private async supervise(bot: TelegramBot, botId: string, username: string) {
    let crashes = 0;
    while (!this.abort.signal.aborted) {
      try {
        await this.run(bot, botId, username);
        return; // clean exit: stop() or a revoked token
      } catch (err) {
        crashes++;
        logger.error('telegram.loop_crashed', { attempt: crashes, message: String((err as Error)?.message ?? err).slice(0, 200) });
        this.status = { state: 'error', reason: 'Polling hit an error; restarting automatically.' };
        await sleep(this.deps.backoffMs?.(crashes) ?? Math.min(60_000, 2000 * 2 ** Math.min(crashes, 5)), this.abort.signal);
      }
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }

  private async run(bot: TelegramBot, botId: string, username: string) {
    const { db, client } = this.deps;
    const signal = this.abort.signal;
    await db.query(`INSERT INTO telegram_bot_state (bot_id) VALUES ($1) ON CONFLICT DO NOTHING`, [botId]);
    let failures = 0;
    let announcedWait = false;

    while (!signal.aborted) {
      // Single consumer: hold (or renew) the lease before every long poll.
      const lease = await db
        .query<{ last_update_id: string | null }>(
          `UPDATE telegram_bot_state
             SET lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3::double precision), updated_at = now()
           WHERE bot_id = $1 AND (lease_owner IS NULL OR lease_owner = $2 OR lease_expires_at < now())
           RETURNING last_update_id`,
          [botId, this.owner, LEASE_SECONDS],
        )
        .catch((err) => {
          // Database unreachable (network, Supabase paused): wait and retry rather than exit.
          logger.warn('telegram.db_unavailable', { message: String((err as Error)?.message ?? err).slice(0, 120) });
          return null;
        });
      if (lease === null) {
        this.status = { state: 'error', reason: 'Database unreachable; retrying.' };
        await sleep(this.deps.backoffMs?.(++failures) ?? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal);
        continue;
      }
      if (lease.rows.length === 0) {
        if (!announcedWait) {
          logger.warn('telegram.lease_held_elsewhere', { username, hint: 'Another process is polling this bot. Stop it, or wait for its lease to expire.' });
          announcedWait = true;
        }
        this.status = { state: 'waiting_for_lease', username };
        await sleep(15_000, signal);
        continue;
      }
      if (this.status.state !== 'running') {
        this.status = { state: 'running', username, mode: 'polling' };
        logger.info('telegram.polling_started', { username });
        announcedWait = false;
      }

      const offset = lease.rows[0]!.last_update_id === null ? undefined : Number(lease.rows[0]!.last_update_id) + 1;
      let updates: TgUpdate[];
      const pollStarted = Date.now();
      try {
        updates = await client.call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
          { timeoutMs: (LONG_POLL_SECONDS + 10) * 1000, signal, retries: 0 },
        );
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        if (err instanceof TelegramApiError && err.isConflict) {
          logger.error('telegram.polling_conflict', { username, hint: 'Another getUpdates consumer (or a webhook) is active for this token.' });
        } else if (err instanceof TelegramApiError && err.isUnauthorized) {
          this.status = { state: 'disabled', reason: 'Token rejected by Telegram while polling (revoked?).' };
          logger.error('telegram.token_revoked', {});
          break;
        } else {
          logger.warn('telegram.poll_failed', { attempt: failures, status: err instanceof TelegramApiError ? err.status : 'network' });
        }
        await sleep(this.deps.backoffMs?.(failures) ?? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal);
        continue;
      }

      if (updates.length > 0) {
        const maxId = Math.max(...updates.map((u) => u.update_id));
        // Persist the offset first: at-most-once delivery, with update_id dedupe as a backstop.
        await db.query(`UPDATE telegram_bot_state SET last_update_id = $2, updated_at = now() WHERE bot_id = $1`, [botId, maxId]);
        for (const u of updates) void bot.enqueue(u);
      } else if (Date.now() - pollStarted < 1000) {
        // A long poll should block ~25s. An instant empty answer means something upstream is off;
        // never spin (that would starve the event loop).
        await sleep(1000, signal);
      }
    }

    await bot.idle().catch(() => undefined);
    await db
      .query(`UPDATE telegram_bot_state SET lease_owner = NULL, lease_expires_at = NULL WHERE bot_id = $1 AND lease_owner = $2`, [botId, this.owner])
      .catch(() => undefined);
    if (this.status.state === 'running') this.status = { state: 'disabled', reason: 'stopped' };
    logger.info('telegram.polling_stopped', { username });
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
