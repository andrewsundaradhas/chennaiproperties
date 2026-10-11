import type { Env } from '../config/env.js';
import { GeminiProvider } from './gemini.js';
import type { AiProvider } from './provider.js';
import { RulesProvider } from './rules.js';

export function createAiProvider(env: Env): AiProvider {
  if (env.aiProvider === 'gemini') {
    return new GeminiProvider({
      apiKey: env.GEMINI_API_KEY!,
      model: env.GEMINI_MODEL!,
      timeoutMs: env.GEMINI_TIMEOUT_MS,
      thinkingLevel: env.GEMINI_THINKING_LEVEL,
    });
  }
  return new RulesProvider();
}

export { RulesProvider } from './rules.js';
export * from './provider.js';
