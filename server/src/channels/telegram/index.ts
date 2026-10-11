// Wires the Telegram adapter into the API process. Missing or invalid configuration disables the
// bot with a clear log line; it never prevents the web chat or dashboard from starting.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHandler } from 'express';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import type { ConversationDeps } from '../../services/conversation.service.js';
import { TelegramApiError, TelegramClient, type TgUpdate, type TgUser } from './api.js';
import { TelegramBot } from './bot.js';
import { TelegramPoller, type TelegramStatus } from './poller.js';

export const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../web/public');

export interface TelegramIntegration {
  status(): TelegramStatus;
  start(): Promise<TelegramStatus>;
  stop(): Promise<void>;
  /** Express handler for webhook mode (null unless TELEGRAM_MODE=webhook). */
  webhook: RequestHandler | null;
}

export function setupTelegram(opts: {
  db: Db;
  env: Env;
  conversation: ConversationDeps;
  fetchImpl?: typeof fetch;
}): TelegramIntegration {
  const { env } = opts;
  const token = env.TELEGRAM_BOT_TOKEN;
  const mode = env.TELEGRAM_MODE ?? (token ? 'polling' : 'off');

  const disabled = (reason: string): TelegramIntegration => {
    const status: TelegramStatus = { state: 'disabled', reason };
    return { status: () => status, start: async () => status, stop: async () => undefined, webhook: null };
  };
  if (mode === 'off') {
    return disabled(token ? 'TELEGRAM_MODE=off' : 'Not configured. Add TELEGRAM_BOT_TOKEN to .env (see README → Telegram bot).');
  }
  if (!token) return disabled('TELEGRAM_MODE is set but TELEGRAM_BOT_TOKEN is missing. Add it to .env.');
  if (!TELEGRAM_TOKEN_RE.test(token)) {
    return disabled('TELEGRAM_BOT_TOKEN is not in the expected format (123456789:ABC…). Copy it again from @BotFather.');
  }

  const client = new TelegramClient({ token, fetchImpl: opts.fetchImpl });
  const makeBot = (me: TgUser) =>
    new TelegramBot({
      db: opts.db,
      conversation: opts.conversation,
      client,
      botId: String(me.id),
      publicDir: PUBLIC_DIR,
      publicBaseUrl: env.publicBaseUrl,
      maxMessagesPerMinute: env.TELEGRAM_MAX_MESSAGES_PER_MINUTE,
    });

  if (mode === 'polling') {
    const poller = new TelegramPoller({ db: opts.db, client, makeBot });
    return {
      status: () => poller.status,
      start: () => poller.start(),
      stop: () => poller.stop(),
      webhook: null,
    };
  }

  // Webhook mode: Telegram POSTs updates to /api/telegram/webhook with our secret header.
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return disabled('TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_SECRET.');
  let status: TelegramStatus = { state: 'starting' };
  let bot: TelegramBot | null = null;
  let starting: Promise<TelegramStatus> | null = null;
  const expected = Buffer.from(secret);
  async function start(): Promise<TelegramStatus> {
    try {
      const me = await client.call<TgUser>('getMe', {}, { retries: 2 });
      bot = makeBot(me);
      status = { state: 'running', username: me.username ?? String(me.id), mode: 'webhook' };
    } catch (err) {
      const reason =
        err instanceof TelegramApiError && err.isUnauthorized ? 'TELEGRAM_BOT_TOKEN was rejected by Telegram.' : 'Could not reach Telegram.';
      status = { state: err instanceof TelegramApiError && err.isUnauthorized ? 'disabled' : 'error', reason };
      logger.error('telegram.start_failed', { reason });
      starting = null; // allow a later request to retry
    }
    return status;
  }
  const ensureStarted = () => (starting ??= start());
  const webhook: RequestHandler = async (req, res) => {
    const got = Buffer.from(req.get('x-telegram-bot-api-secret-token') ?? '');
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Bad webhook secret' } });
      return;
    }
    const update = req.body as TgUpdate;
    if (typeof update?.update_id !== 'number') {
      res.status(400).json({ ok: false });
      return;
    }
    await ensureStarted();
    if (!bot) {
      res.status(503).json({ ok: false }); // Telegram retries later
      return;
    }
    if (env.serverless) {
      // Serverless instances may be frozen once the response is sent, so finish first.
      // Errors are handled (and the user told) inside handleUpdate; always 200 to avoid retry storms.
      await bot.handleUpdate(update);
      res.json({ ok: true });
    } else {
      res.json({ ok: true }); // long-lived server: acknowledge fast, process in the background
      void bot.enqueue(update);
    }
  };
  return {
    status: () => status,
    start: ensureStarted,
    async stop() {
      await bot?.idle();
    },
    webhook,
  };
}
