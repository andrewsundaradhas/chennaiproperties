// Thin client for the official Telegram Bot API (https://core.telegram.org/bots/api).
// No third-party library: the handful of methods we need are plain HTTPS calls, and owning the
// client keeps retries, timeouts and token redaction explicit and easy to mock in tests.
import { logger } from '../../lib/logger.js';

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    public readonly description: string,
    public readonly retryAfterSec?: number,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
  }
  get isUnauthorized() {
    return this.status === 401 || this.status === 404; // 404 on every method = malformed token
  }
  get isConflict() {
    return this.status === 409;
  }
}

export interface TelegramClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  /** Timeout for ordinary calls; getUpdates adds its long-poll timeout on top. */
  timeoutMs?: number;
  maxRetries?: number;
  baseUrl?: string;
}

export type InputFile = { data: Uint8Array<ArrayBuffer>; filename: string; contentType: string };

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly base: string;

  constructor(private readonly opts: TelegramClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.base = `${opts.baseUrl ?? 'https://api.telegram.org'}/bot${opts.token}`;
  }

  /** Removes the token from any text before it can reach a log line. */
  redact(text: string): string {
    return text.split(this.opts.token).join('<redacted-token>');
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { files?: Record<string, InputFile>; timeoutMs?: number; signal?: AbortSignal; retries?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, params, opts);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const retryable =
          !(err instanceof TelegramApiError) || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= retries) throw err;
        const waitMs =
          err instanceof TelegramApiError && err.retryAfterSec !== undefined
            ? Math.min(err.retryAfterSec, 30) * 1000
            : 500 * 2 ** attempt;
        logger.warn('telegram.retry', {
          method,
          attempt: attempt + 1,
          status: err instanceof TelegramApiError ? err.status : 'network',
        });
        await sleep(waitMs, opts.signal);
      }
    }
  }

  private async once<T>(
    method: string,
    params: Record<string, unknown>,
    opts: { files?: Record<string, InputFile>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      let body: FormData | string;
      const headers: Record<string, string> = {};
      if (opts.files && Object.keys(opts.files).length > 0) {
        const form = new FormData();
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined) continue;
          form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
        for (const [field, f] of Object.entries(opts.files)) {
          form.append(field, new Blob([f.data], { type: f.contentType }), f.filename);
        }
        body = form;
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(params);
      }
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/${method}`, { method: 'POST', headers, body, signal: ctrl.signal });
      } catch {
        // Never surface the underlying error: it can embed the request URL (which contains the token).
        throw new Error(ctrl.signal.aborted ? `Telegram ${method} timed out` : `Telegram ${method} network error`);
      }
      const data = (await res.json().catch(() => ({ ok: false, description: 'invalid JSON from Telegram' }))) as ApiResponse<T>;
      if (!res.ok || !data.ok) {
        throw new TelegramApiError(method, data.error_code ?? res.status, this.redact(data.description ?? 'unknown error'), data.parameters?.retry_after);
      }
      return data.result as T;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// --- Minimal Telegram types used by this app -----------------------------------------------

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}
export interface TgContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  contact?: TgContact;
  photo?: unknown[];
  sticker?: unknown;
  voice?: unknown;
  document?: unknown;
  location?: unknown;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat };
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface InlineButton {
  text: string;
  callback_data: string;
}
export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { keyboard: { text: string; request_contact?: boolean }[][]; resize_keyboard?: boolean; one_time_keyboard?: boolean }
  | { remove_keyboard: true };
