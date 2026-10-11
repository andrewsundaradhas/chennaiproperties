// Web-chat channel adapter: anonymous sessions identified by a bearer token. It only creates
// sessions and shapes messages for the browser; all conversation logic lives in
// services/conversation.service.ts and is shared with any future channel.
import crypto from 'node:crypto';
import type { Queryable } from '../db/client.js';
import type { Card } from '../domain/cards.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { conversationsRepo, customersRepo, type Message } from '../repositories/conversations.repo.js';

export async function createWebSession(q: Queryable): Promise<{ sessionId: string; token: string }> {
  const token = randomToken();
  const customer = await customersRepo.upsert(q, 'web', `web-${crypto.randomUUID()}`);
  const conversation = await conversationsRepo.create(q, customer.id, 'web', sha256(token));
  return { sessionId: conversation.id, token };
}

export interface ChatMessageDto {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
  cards: Card[];
  retryable: boolean;
}

export function toMessageDto(m: Message): ChatMessageDto {
  const meta = m.metadata_json ?? {};
  return {
    id: m.id,
    direction: m.direction,
    body: m.body,
    created_at: m.created_at.toISOString(),
    cards: Array.isArray(meta.cards) ? (meta.cards as Card[]) : [],
    retryable: meta.retryable === true,
  };
}
