import type { Queryable } from '../db/client.js';

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'agent';
  password_hash: string | null;
  created_at: Date;
  last_login_at: Date | null;
}

export const adminRepo = {
  async findByEmail(q: Queryable, email: string): Promise<AdminUser | null> {
    const { rows } = await q.query<AdminUser>('SELECT * FROM admin_users WHERE lower(email) = lower($1)', [email]);
    return rows[0] ?? null;
  },
  async upsertLocal(
    q: Queryable,
    u: { email: string; display_name: string; password_hash: string; role: AdminUser['role'] },
  ): Promise<AdminUser> {
    const email = u.email.toLowerCase();
    const { rows } = await q.query<AdminUser>(
      `INSERT INTO admin_users (auth_provider, auth_provider_id, email, display_name, role, password_hash)
       VALUES ('local', $1, $1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         display_name = EXCLUDED.display_name, role = EXCLUDED.role
       RETURNING *`,
      [email, u.display_name, u.role, u.password_hash],
    );
    return rows[0]!;
  },
  async createSession(q: Queryable, adminId: string, tokenHash: string, expiresAt: Date) {
    await q.query(`INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
      adminId,
      tokenHash,
      expiresAt,
    ]);
    await q.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [adminId]);
  },
  async findSession(q: Queryable, tokenHash: string): Promise<AdminUser | null> {
    const { rows } = await q.query<AdminUser>(
      `SELECT u.* FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },
  async deleteSession(q: Queryable, tokenHash: string) {
    await q.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash]);
  },
};

export const auditRepo = {
  async record(
    q: Queryable,
    e: {
      actor_type: 'admin' | 'customer' | 'system';
      actor_id?: string | null;
      action: string;
      entity_type: string;
      entity_id?: string | null;
      details?: Record<string, unknown>;
    },
  ) {
    await q.query(
      `INSERT INTO audit_events (actor_type, actor_id, action, entity_type, entity_id, details_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.actor_type, e.actor_id ?? null, e.action, e.entity_type, e.entity_id ?? null, JSON.stringify(e.details ?? {})],
    );
  },
};
