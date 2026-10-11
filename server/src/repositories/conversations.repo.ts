import type { Queryable } from '../db/client.js';
import type { Channel } from '../domain/enums.js';
import {
  EMPTY_REQUIREMENTS,
  type ConfidenceMap,
  type Requirements,
} from '../domain/requirements.js';

export interface Customer {
  id: string;
  external_channel: Channel;
  external_user_id: string;
  display_name: string | null;
  phone: string | null;
  preferred_language: string | null;
  consent_status: 'unknown' | 'granted' | 'withdrawn';
  created_at: Date;
  last_contact_at: Date;
}

export interface Conversation {
  id: string;
  customer_id: string;
  channel: Channel;
  status: 'active' | 'closed';
  agent_takeover: boolean;
  last_result_ids: string[];
  external_chat_id: string | null;
  channel_state: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  provider_message_id: string | null;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'system';
  body: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
}

const CONV_COLS = `id, customer_id, channel, status, agent_takeover, last_result_ids::text[] AS last_result_ids,
  external_chat_id, channel_state, created_at, updated_at, last_message_at`;

export const customersRepo = {
  /** Finds or creates the customer for a channel identity (unique per channel + external id). */
  async upsert(q: Queryable, channel: Channel, externalUserId: string): Promise<Customer> {
    const { rows } = await q.query<Customer>(
      `INSERT INTO customers (external_channel, external_user_id) VALUES ($1, $2)
       ON CONFLICT (external_channel, external_user_id) DO UPDATE SET last_contact_at = now()
       RETURNING *`,
      [channel, externalUserId],
    );
    return rows[0]!;
  },
  async getById(q: Queryable, id: string): Promise<Customer | null> {
    const { rows } = await q.query<Customer>('SELECT * FROM customers WHERE id = $1', [id]);
    return rows[0] ?? null;
  },
  async updateContact(
    q: Queryable,
    id: string,
    c: { display_name?: string; phone?: string; consent_status?: Customer['consent_status']; preferred_language?: string },
  ): Promise<Customer> {
    const { rows } = await q.query<Customer>(
      `UPDATE customers SET
         display_name = COALESCE($2, display_name),
         phone = COALESCE($3, phone),
         consent_status = COALESCE($4, consent_status),
         preferred_language = COALESCE($5, preferred_language),
         last_contact_at = now()
       WHERE id = $1 RETURNING *`,
      [id, c.display_name ?? null, c.phone ?? null, c.consent_status ?? null, c.preferred_language ?? null],
    );
    return rows[0]!;
  },
};

export const conversationsRepo = {
  async create(
    q: Queryable,
    customerId: string,
    channel: Channel,
    sessionTokenHash: string | null,
    externalChatId: string | null = null,
  ): Promise<Conversation> {
    const { rows } = await q.query<Conversation>(
      `INSERT INTO conversations (customer_id, channel, session_token_hash, external_chat_id) VALUES ($1, $2, $3, $4)
       RETURNING ${CONV_COLS}`,
      [customerId, channel, sessionTokenHash, externalChatId],
    );
    return rows[0]!;
  },
  async getById(q: Queryable, id: string): Promise<Conversation | null> {
    const { rows } = await q.query<Conversation>(`SELECT ${CONV_COLS} FROM conversations WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },
  async getByIdAndTokenHash(q: Queryable, id: string, tokenHash: string): Promise<Conversation | null> {
    const { rows } = await q.query<Conversation>(
      `SELECT ${CONV_COLS} FROM conversations WHERE id = $1 AND session_token_hash = $2`,
      [id, tokenHash],
    );
    return rows[0] ?? null;
  },
  async latestActiveForCustomer(q: Queryable, customerId: string): Promise<Conversation | null> {
    const { rows } = await q.query<Conversation>(
      `SELECT ${CONV_COLS} FROM conversations WHERE customer_id = $1 AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
      [customerId],
    );
    return rows[0] ?? null;
  },
  async setLastResults(q: Queryable, id: string, propertyIds: string[]): Promise<void> {
    await q.query(`UPDATE conversations SET last_result_ids = $2::uuid[], updated_at = now() WHERE id = $1`, [
      id,
      propertyIds,
    ]);
  },
  /** Ends a conversation's context (e.g. Telegram /reset). Messages and leads are kept. */
  async close(q: Queryable, id: string): Promise<void> {
    await q.query(`UPDATE conversations SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
  },
  async setChannelState(q: Queryable, id: string, state: Record<string, unknown>): Promise<void> {
    await q.query(`UPDATE conversations SET channel_state = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(state)]);
  },
  async touch(q: Queryable, id: string): Promise<void> {
    await q.query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [id]);
  },
};

export const messagesRepo = {
  /** Returns null when the provider message id was already stored (duplicate delivery). */
  async insert(
    q: Queryable,
    m: {
      conversation_id: string;
      direction: Message['direction'];
      body: string;
      provider_message_id?: string | null;
      message_type?: Message['message_type'];
      metadata?: Record<string, unknown>;
    },
  ): Promise<Message | null> {
    const { rows } = await q.query<Message>(
      `INSERT INTO messages (conversation_id, provider_message_id, direction, message_type, body, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (conversation_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        m.conversation_id,
        m.provider_message_id ?? null,
        m.direction,
        m.message_type ?? 'text',
        m.body,
        JSON.stringify(m.metadata ?? {}),
      ],
    );
    return rows[0] ?? null;
  },
  async findByProviderId(q: Queryable, conversationId: string, providerId: string): Promise<Message | null> {
    const { rows } = await q.query<Message>(
      `SELECT * FROM messages WHERE conversation_id = $1 AND provider_message_id = $2`,
      [conversationId, providerId],
    );
    return rows[0] ?? null;
  },
  async findReplyTo(q: Queryable, conversationId: string, inboundId: string): Promise<Message | null> {
    const { rows } = await q.query<Message>(
      `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'outbound'
         AND metadata_json->>'reply_to' = $2 ORDER BY created_at LIMIT 1`,
      [conversationId, inboundId],
    );
    return rows[0] ?? null;
  },
  async list(q: Queryable, conversationId: string, limit = 100): Promise<Message[]> {
    const { rows } = await q.query<Message>(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [conversationId, limit],
    );
    return rows;
  },
};

interface RequirementsRow extends Requirements {
  confidence_json: ConfidenceMap;
  updated_at: Date;
}

export const requirementsRepo = {
  async get(q: Queryable, conversationId: string): Promise<{ requirements: Requirements; confidence: ConfidenceMap; updated_at: Date | null }> {
    const { rows } = await q.query<RequirementsRow>(
      `SELECT transaction_type, locality_terms, budget_min, budget_max, bedrooms, property_type, furnishing,
              parking_required, pets_required, amenities, confidence_json, updated_at
       FROM customer_requirements WHERE conversation_id = $1`,
      [conversationId],
    );
    const r = rows[0];
    if (!r) return { requirements: { ...EMPTY_REQUIREMENTS }, confidence: {}, updated_at: null };
    const { confidence_json, updated_at, ...requirements } = r;
    return { requirements: requirements as Requirements, confidence: confidence_json, updated_at };
  },
  async save(
    q: Queryable,
    conversationId: string,
    customerId: string,
    r: Requirements,
    confidence: ConfidenceMap,
  ): Promise<void> {
    await q.query(
      `INSERT INTO customer_requirements (conversation_id, customer_id, transaction_type, locality_terms,
         budget_min, budget_max, bedrooms, property_type, furnishing, parking_required, pets_required,
         amenities, confidence_json, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         transaction_type=EXCLUDED.transaction_type, locality_terms=EXCLUDED.locality_terms,
         budget_min=EXCLUDED.budget_min, budget_max=EXCLUDED.budget_max, bedrooms=EXCLUDED.bedrooms,
         property_type=EXCLUDED.property_type, furnishing=EXCLUDED.furnishing,
         parking_required=EXCLUDED.parking_required, pets_required=EXCLUDED.pets_required,
         amenities=EXCLUDED.amenities, confidence_json=EXCLUDED.confidence_json, updated_at=now()`,
      [
        conversationId,
        customerId,
        r.transaction_type,
        r.locality_terms,
        r.budget_min,
        r.budget_max,
        r.bedrooms,
        r.property_type,
        r.furnishing,
        r.parking_required,
        r.pets_required,
        r.amenities,
        JSON.stringify(confidence),
      ],
    );
  },
};

export const shortlistsRepo = {
  /** Idempotent. Returns whether a new row was created. */
  async add(q: Queryable, customerId: string, conversationId: string, propertyId: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `INSERT INTO shortlists (customer_id, conversation_id, property_id) VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, conversation_id, property_id) DO NOTHING`,
      [customerId, conversationId, propertyId],
    );
    return rowCount > 0;
  },
  async listPropertyIds(q: Queryable, conversationId: string): Promise<string[]> {
    const { rows } = await q.query<{ property_id: string }>(
      `SELECT property_id FROM shortlists WHERE conversation_id = $1 ORDER BY created_at`,
      [conversationId],
    );
    return rows.map((r) => r.property_id);
  },
};

export const faqRepo = {
  async get(q: Queryable, key: string) {
    const { rows } = await q.query<{ key: string; question: string; answer: string; is_demo: boolean }>(
      'SELECT key, question, answer, is_demo FROM business_faqs WHERE key = $1',
      [key],
    );
    return rows[0] ?? null;
  },
  async keys(q: Queryable): Promise<string[]> {
    const { rows } = await q.query<{ key: string }>('SELECT key FROM business_faqs ORDER BY key');
    return rows.map((r) => r.key);
  },
};
