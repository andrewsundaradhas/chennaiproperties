import request from 'supertest';
import { loadEnv } from '../src/config/env.js';
import { createDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemo } from '../src/db/seed.js';
import { createApp } from '../src/http/app.js';
import type { AiProvider } from '../src/ai/provider.js';
import { RulesProvider } from '../src/ai/rules.js';
import { hashPassword } from '../src/lib/crypto.js';
import { adminRepo } from '../src/repositories/admin.repo.js';
import type { ConversationDeps } from '../src/services/conversation.service.js';
import { createWebSession } from '../src/channels/web.js';
import { conversationsRepo } from '../src/repositories/conversations.repo.js';

export const testEnv = loadEnv({ NODE_ENV: 'test', AI_PROVIDER: 'rules', APP_ORIGIN: 'http://localhost:5173' });

export async function makeDb(opts: { seed?: boolean } = {}): Promise<Db> {
  const db = await createDb({ pgliteDataDir: 'memory' });
  await migrate(db);
  if (opts.seed !== false) await seedDemo(db);
  return db;
}

export function makeApp(db: Db, ai: AiProvider = new RulesProvider()) {
  return createApp({ db, env: testEnv, ai });
}

export function deps(db: Db, ai: AiProvider = new RulesProvider()): ConversationDeps {
  return { db, ai, fallback: new RulesProvider() };
}

export async function newConversation(db: Db) {
  const { sessionId } = await createWebSession(db);
  return (await conversationsRepo.getById(db, sessionId))!;
}

export const ADMIN = { email: 'admin@test.local', password: 'correct-horse-battery' };

export async function adminAgent(db: Db) {
  await adminRepo.upsertLocal(db, {
    email: ADMIN.email,
    display_name: 'Test Admin',
    role: 'admin',
    password_hash: await hashPassword(ADMIN.password),
  });
  const app = makeApp(db);
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/auth/login').send(ADMIN);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { app, agent };
}

export async function chatSession(app: Parameters<typeof request>[0]) {
  const res = await request(app).post('/api/chat/sessions').send({});
  const { session_id, token } = res.body as { session_id: string; token: string };
  const send = (text: string, client_message_id?: string) =>
    request(app)
      .post(`/api/chat/sessions/${session_id}/messages`)
      .set('authorization', `Bearer ${token}`)
      .send({ text, client_message_id });
  return { session_id, token, send };
}
