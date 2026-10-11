import { logger } from '../lib/logger.js';
import { AiError, type AiProvider, type ComposeInput, type InterpretInput } from './provider.js';
import { composePrompt, interpretPrompt, SYSTEM_PROMPT } from './prompts.js';
import { InterpretationSchema, type Interpretation } from './schemas.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRY_DELAYS_MS = [400, 1200]; // bounded: at most 3 attempts in total

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  thinkingLevel?: 'low' | 'high' | 'none';
  fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async interpret(input: InterpretInput, signal?: AbortSignal): Promise<Interpretation> {
    const contents = [
      ...input.history.slice(-8).map((h) => ({
        role: h.role === 'customer' ? 'user' : 'model',
        parts: [{ text: h.text.slice(0, 1500) }],
      })),
      { role: 'user', parts: [{ text: interpretPrompt(input) }] },
    ];
    const text = await this.generate(contents, { json: true, temperature: 0.1 }, signal);
    let json: unknown;
    try {
      json = JSON.parse(stripFences(text));
    } catch {
      throw new AiError('invalid_output', 'Model returned non-JSON output', false);
    }
    const parsed = InterpretationSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn('ai.invalid_interpretation', { issues: parsed.error.issues.length });
      throw new AiError('invalid_output', 'Model output failed schema validation', false);
    }
    return parsed.data;
  }

  async compose(input: ComposeInput, signal?: AbortSignal): Promise<string> {
    const text = await this.generate(
      [{ role: 'user', parts: [{ text: composePrompt(input) }] }],
      { json: false, temperature: 0.4 },
      signal,
    );
    return text.trim();
  }

  private async generate(
    contents: unknown[],
    cfg: { json: boolean; temperature: number },
    signal?: AbortSignal,
  ): Promise<string> {
    const model = this.opts.model.replace(/^models\//, '');
    const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: cfg.temperature,
        maxOutputTokens: 1024,
        ...(cfg.json ? { responseMimeType: 'application/json' } : {}),
        ...(this.opts.thinkingLevel && this.opts.thinkingLevel !== 'none'
          ? { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel } }
          : {}),
      },
    });

    let lastError: AiError | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!, signal);
      try {
        return await this.once(url, body, signal);
      } catch (err) {
        lastError = err instanceof AiError ? err : new AiError('provider_error', 'Unexpected provider error', true);
        if (!lastError.retryable || signal?.aborted) break;
        logger.warn('ai.retry', { attempt: attempt + 1, category: lastError.category });
      }
    }
    throw lastError!;
  }

  private async once(url: string, body: string, outer?: AbortSignal): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    outer?.addEventListener('abort', onOuterAbort);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body,
        signal: ctrl.signal,
      });
      // Not retried: quick retries only burn more quota. The caller falls back to the rule-based interpreter.
      if (res.status === 429) throw new AiError('rate_limited', 'Provider rate limit', false);
      if (res.status >= 500) throw new AiError('provider_error', `Provider HTTP ${res.status}`, true);
      if (res.status === 401 || res.status === 403) throw new AiError('config', 'Provider rejected credentials', false);
      if (!res.ok) throw new AiError('provider_error', `Provider HTTP ${res.status}`, false);
      const data = (await res.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new AiError('invalid_output', 'Provider returned no content', false);
      return text;
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (ctrl.signal.aborted) throw new AiError('timeout', 'Provider request timed out', true);
      throw new AiError('provider_error', 'Provider network error', true);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }
}

const stripFences = (s: string) => s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
