import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/gemini.js';
import { loadEnv } from '../src/config/env.js';
import { EMPTY_REQUIREMENTS } from '../src/domain/requirements.js';

const input = { message: '2bhk for rent in adyar', history: [], requirements: EMPTY_REQUIREMENTS, lastResults: [], faqKeys: [] };
const ok = (obj: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });

function provider(fetchImpl: typeof fetch, timeoutMs = 2000) {
  return new GeminiProvider({ apiKey: 'test-key', model: 'models/test-model', timeoutMs, fetchImpl });
}

describe('Gemini adapter (mocked HTTP)', () => {
  it('sends the key in a header (not the URL) and validates structured output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ intent: 'search', requirements: { set: { transaction_type: 'rent', bedrooms: 2, locality_terms: ['Adyar'] } } }));
    const r = await provider(fetchImpl).interpret(input);
    expect(r.intent).toBe('search');
    expect(r.requirements.set).toMatchObject({ transaction_type: 'rent', bedrooms: 2 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/models/test-model:generateContent');
    expect(url).not.toContain('test-key');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
  });

  it('retries transient errors a bounded number of times', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(ok({ intent: 'greeting' }));
    expect((await provider(fetchImpl).interpret(input)).intent).toBe('greeting');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const always500 = vi.fn().mockImplementation(async () => new Response('err', { status: 500 }));
    await expect(provider(always500).interpret(input)).rejects.toMatchObject({ category: 'provider_error' });
    expect(always500).toHaveBeenCalledTimes(3);
  });

  it('does not retry rate limits (fails fast so the caller can fall back)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('quota', { status: 429 }));
    await expect(provider(fetchImpl).interpret(input)).rejects.toMatchObject({ category: 'rate_limited' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends a low thinking level by default and can omit it', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok({ intent: 'greeting' }));
    await new GeminiProvider({ apiKey: 'k', model: 'm', timeoutMs: 1000, thinkingLevel: 'low', fetchImpl }).interpret(input);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    await new GeminiProvider({ apiKey: 'k', model: 'm', timeoutMs: 1000, thinkingLevel: 'none', fetchImpl }).interpret(input);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).generationConfig.thinkingConfig).toBeUndefined();
  });

  it('does not retry auth errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }));
    await expect(provider(fetchImpl).interpret(input)).rejects.toMatchObject({ category: 'config' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies invalid JSON and schema violations as invalid_output', async () => {
    const notJson = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'sure! here you go' }] } }] })));
    await expect(provider(notJson).interpret(input)).rejects.toMatchObject({ category: 'invalid_output' });
    const unknownTool = vi.fn().mockResolvedValue(ok({ intent: 'execute_sql', sql: 'DROP TABLE x' }));
    await expect(provider(unknownTool).interpret(input)).rejects.toMatchObject({ category: 'invalid_output' });
  });

  it('times out slow requests', async () => {
    const hang = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    await expect(provider(hang, 50).interpret(input)).rejects.toMatchObject({ category: 'timeout' });
    expect(hang).toHaveBeenCalledTimes(3);
  });
});

describe('environment validation', () => {
  it('defaults to the rule-based provider without a key and requires a model name with one', () => {
    expect(loadEnv({}).aiProvider).toBe('rules');
    expect(() => loadEnv({ GEMINI_API_KEY: 'k' })).toThrow(/GEMINI_MODEL/);
    expect(loadEnv({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'some-model' }).aiProvider).toBe('gemini');
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });
});
