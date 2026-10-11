import type { Requirements } from '../domain/requirements.js';
import type { Interpretation } from './schemas.js';

export interface InterpretInput {
  message: string;
  /** Recent turns, oldest first. Bodies only — no internal metadata. */
  history: { role: 'customer' | 'assistant'; text: string }[];
  requirements: Requirements;
  /** The current result set, so "the second one" can be resolved. */
  lastResults: { index: number; listing_code: string; title: string }[];
  faqKeys: string[];
}

export interface ComposeInput {
  message: string;
  language: Interpretation['language'];
  /** Deterministic, fully grounded reply. The rewrite may only rephrase it. */
  draft: string;
  /** All facts the reply may use (tool results). */
  facts: unknown;
}

export interface AiProvider {
  readonly name: string;
  interpret(input: InterpretInput, signal?: AbortSignal): Promise<Interpretation>;
  /** Optional natural-language polish / translation of the grounded draft. */
  compose?(input: ComposeInput, signal?: AbortSignal): Promise<string>;
}

export type AiErrorCategory = 'timeout' | 'rate_limited' | 'provider_error' | 'invalid_output' | 'config';

export class AiError extends Error {
  constructor(
    public readonly category: AiErrorCategory,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
