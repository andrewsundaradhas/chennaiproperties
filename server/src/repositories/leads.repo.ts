import type { Queryable } from '../db/client.js';
import type { EnquiryType, LeadStatus } from '../domain/enums.js';

export interface Lead {
  id: string;
  customer_id: string;
  conversation_id: string | null;
  property_id: string | null;
  enquiry_type: EnquiryType;
  status: LeadStatus;
  preferred_visit_at: Date | null;
  preferred_time_text: string | null;
  assigned_agent: string | null;
  notes: string | null;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LeadListItem extends Lead {
  customer_name: string | null;
  customer_phone: string | null;
  listing_code: string | null;
  property_title: string | null;
}

export const leadsRepo = {
  /** Inserts a lead. With an idempotency key, a repeat returns the original lead (created=false). */
  async create(
    q: Queryable,
    l: {
      customer_id: string;
      conversation_id: string | null;
      property_id: string | null;
      enquiry_type: EnquiryType;
      status: LeadStatus;
      preferred_visit_at?: Date | null;
      preferred_time_text?: string | null;
      notes?: string | null;
      idempotency_key?: string | null;
    },
  ): Promise<{ lead: Lead; created: boolean }> {
    const { rows } = await q.query<Lead>(
      `INSERT INTO leads (customer_id, conversation_id, property_id, enquiry_type, status,
         preferred_visit_at, preferred_time_text, notes, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [
        l.customer_id,
        l.conversation_id,
        l.property_id,
        l.enquiry_type,
        l.status,
        l.preferred_visit_at ?? null,
        l.preferred_time_text ?? null,
        l.notes ?? null,
        l.idempotency_key ?? null,
      ],
    );
    if (rows[0]) return { lead: rows[0], created: true };
    const existing = await q.query<Lead>('SELECT * FROM leads WHERE idempotency_key = $1', [l.idempotency_key]);
    return { lead: existing.rows[0]!, created: false };
  },

  /** An open enquiry of the same type for the same conversation + property, to avoid duplicates. */
  async findOpenDuplicate(
    q: Queryable,
    conversationId: string,
    propertyId: string | null,
    enquiryType: EnquiryType,
  ): Promise<Lead | null> {
    const { rows } = await q.query<Lead>(
      `SELECT * FROM leads WHERE conversation_id = $1 AND property_id IS NOT DISTINCT FROM $2
         AND enquiry_type = $3 AND status IN ('new', 'visit_requested')
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId, propertyId, enquiryType],
    );
    return rows[0] ?? null;
  },

  async getById(q: Queryable, id: string): Promise<Lead | null> {
    const { rows } = await q.query<Lead>('SELECT * FROM leads WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async update(
    q: Queryable,
    id: string,
    patch: { status?: LeadStatus; assigned_agent?: string | null; notes?: string | null },
  ): Promise<Lead | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    if (sets.length === 0) return this.getById(q, id);
    const { rows } = await q.query<Lead>(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  },

  async list(
    q: Queryable,
    f: { status?: LeadStatus; limit: number; offset: number },
  ): Promise<{ items: LeadListItem[]; total: number }> {
    const where = f.status ? 'WHERE l.status = $1' : '';
    const params: unknown[] = f.status ? [f.status] : [];
    const { rows: c } = await q.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM leads l ${where}`,
      params,
    );
    const { rows } = await q.query<LeadListItem>(
      `SELECT l.*, c.display_name AS customer_name, c.phone AS customer_phone,
              p.listing_code, p.title AS property_title
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       LEFT JOIN properties p ON p.id = l.property_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { items: rows, total: c[0]?.total ?? 0 };
  },

  async listForConversation(q: Queryable, conversationId: string): Promise<Lead[]> {
    const { rows } = await q.query<Lead>(
      'SELECT * FROM leads WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId],
    );
    return rows;
  },

  async counts(q: Queryable): Promise<{ new_leads: number; visit_requests: number; total: number }> {
    const { rows } = await q.query<{ new_leads: number; visit_requests: number; total: number }>(
      `SELECT count(*) FILTER (WHERE status = 'new')::int AS new_leads,
              count(*) FILTER (WHERE status = 'visit_requested')::int AS visit_requests,
              count(*)::int AS total
       FROM leads`,
    );
    return rows[0]!;
  },
};
