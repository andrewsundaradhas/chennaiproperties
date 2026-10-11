import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemo } from '../src/db/seed.js';
import { createApp } from '../src/http/app.js';
import { RulesProvider } from '../src/ai/rules.js';
import { ADMIN, adminAgent, chatSession, makeApp, makeDb, testEnv } from './helpers.js';

let db: Db;
let app: ReturnType<typeof makeApp>;
beforeAll(async () => {
  db = await makeDb();
  app = makeApp(db);
});
afterAll(async () => {
  await db.close();
});

describe('health and conventions', () => {
  it('reports minimal health without infrastructure details', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('uses a common error format with a request id', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found', requestId: expect.any(String) });
  });

  it('rejects malformed JSON safely', async () => {
    const { session_id, token } = await chatSession(app);
    const res = await request(app)
      .post(`/api/chat/sessions/${session_id}/messages`)
      .set('authorization', `Bearer ${token}`)
      .set('content-type', 'application/json')
      .send('{"text": ');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|stack/i);
  });
});

describe('customer chat API', () => {
  it('runs a turn and returns result cards', async () => {
    const s = await chatSession(app);
    const res = await s.send('2BHK for rent in Velachery under ₹25,000');
    expect(res.status).toBe(201);
    expect(res.body.inbound.body).toBe('2BHK for rent in Velachery under ₹25,000');
    const card = res.body.reply.cards.find((c: { type: string }) => c.type === 'properties');
    expect(card.items.length).toBeGreaterThan(0);
    expect(card.items[0]).toMatchObject({ listing_code: expect.stringMatching(/^CP-DEMO-/), is_demo: true, price_label: expect.any(String) });
    // Internal fields are not exposed to customers.
    expect(card.items[0]).not.toHaveProperty('source_type');
    expect(card.items[0]).not.toHaveProperty('deactivated_at');
    expect(res.body.requirements.summary).toEqual(expect.arrayContaining(['for rent', '2BHK']));
  });

  it('validates message bodies', async () => {
    const s = await chatSession(app);
    expect((await s.send('')).status).toBe(400);
    expect((await s.send('x'.repeat(2001))).status).toBe(400);
  });

  it('AC-13: history is only readable with the owning session token', async () => {
    const a = await chatSession(app);
    const b = await chatSession(app);
    await a.send('3BHK for rent in Adyar');
    const own = await request(app).get(`/api/chat/sessions/${a.session_id}/messages`).set('authorization', `Bearer ${a.token}`);
    expect(own.status).toBe(200);
    expect(own.body.messages).toHaveLength(2);
    const other = await request(app).get(`/api/chat/sessions/${a.session_id}/messages`).set('authorization', `Bearer ${b.token}`);
    expect(other.status).toBe(404);
    const none = await request(app).get(`/api/chat/sessions/${a.session_id}/messages`);
    expect(none.status).toBe(401);
    const bOwn = await request(app).get(`/api/chat/sessions/${b.session_id}/messages`).set('authorization', `Bearer ${b.token}`);
    expect(bOwn.body.messages).toHaveLength(0);
  });

  it('AC-15: duplicate client message ids do not create duplicate messages', async () => {
    const s = await chatSession(app);
    const first = await s.send('2BHK for rent in Porur', 'client-msg-0001');
    const again = await s.send('2BHK for rent in Porur', 'client-msg-0001');
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.reply.id).toBe(first.body.reply.id);
    const hist = await request(app).get(`/api/chat/sessions/${s.session_id}/messages`).set('authorization', `Bearer ${s.token}`);
    expect(hist.body.messages).toHaveLength(2);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the chat-session limit is exceeded', async () => {
    process.env.DISABLE_RATE_LIMIT = 'false';
    try {
      const limited = makeApp(db);
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) statuses.push((await request(limited).post('/api/chat/sessions').send({})).status);
      expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      process.env.DISABLE_RATE_LIMIT = 'true';
    }
  });
});

describe('public property and lead endpoints', () => {
  it('searches with validated filters and rejects unsupported enums', async () => {
    const ok = await request(app).get('/api/properties').query({ transaction_type: 'sale', locality: 'Velachery' });
    expect(ok.status).toBe(200);
    expect(ok.body.items.every((p: { transaction_type: string }) => p.transaction_type === 'sale')).toBe(true);
    expect((await request(app).get('/api/properties').query({ transaction_type: 'lease' })).status).toBe(400);
  });

  it('fetches listing details by code and hides unknown ids', async () => {
    const res = await request(app).get('/api/properties/CP-DEMO-002');
    expect(res.body.property).toMatchObject({ listing_code: 'CP-DEMO-002', pet_policy: 'allowed' });
    expect((await request(app).get('/api/properties/CP-NOPE-999')).status).toBe(404);
  });

  it('creates an enquiry with consent, and is idempotent with a key', async () => {
    const s = await chatSession(app);
    const property = (await request(app).get('/api/properties/CP-DEMO-008')).body.property;
    const body = { session_id: s.session_id, property_id: property.id, enquiry_type: 'site_visit', preferred_time_text: 'Sunday morning', name: 'Test Customer', phone: '9876500000', consent: true, idempotency_key: 'lead-key-0001' };
    const noConsent = await request(app).post('/api/leads').set('authorization', `Bearer ${s.token}`).send({ ...body, consent: false });
    expect(noConsent.status).toBe(400);
    const badPhone = await request(app).post('/api/leads').set('authorization', `Bearer ${s.token}`).send({ ...body, phone: '12345' });
    expect(badPhone.status).toBe(400);
    const first = await request(app).post('/api/leads').set('authorization', `Bearer ${s.token}`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.lead).toMatchObject({ status: 'visit_requested', confirmed: false });
    expect(first.body.message).toMatch(/not a confirmed booking/);
    const dup = await request(app).post('/api/leads').set('authorization', `Bearer ${s.token}`).send(body);
    expect(dup.status).toBe(200);
    expect(dup.body.lead.id).toBe(first.body.lead.id);
    const wrongSession = await request(app).post('/api/leads').set('authorization', 'Bearer not-the-token').send(body);
    expect(wrongSession.status).toBe(404);
  });
});

describe('admin API', () => {
  it('AC-12: rejects unauthenticated access and returns no protected data', async () => {
    for (const [method, url] of [
      ['get', '/api/admin/leads'],
      ['get', '/api/admin/properties'],
      ['get', '/api/admin/overview'],
      ['post', '/api/admin/properties'],
      ['patch', '/api/admin/leads/00000000-0000-0000-0000-000000000000'],
    ] as const) {
      const res = await request(app)[method](url).send({});
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body).not.toHaveProperty('items');
    }
    const forged = await request(app).get('/api/admin/leads').set('cookie', 'cp_admin=forged-token');
    expect(forged.status).toBe(401);
  });

  it('rejects wrong credentials with a generic message', async () => {
    await adminAgent(db);
    const res = await request(app).post('/api/admin/auth/login').send({ email: ADMIN.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    const unknown = await request(app).post('/api/admin/auth/login').send({ email: 'nobody@test.local', password: 'x' });
    expect(unknown.body.error.message).toBe(res.body.error.message);
  });

  it('sets an httpOnly session cookie and supports logout', async () => {
    const res = await request(app).post('/api/admin/auth/login').send(ADMIN);
    expect(res.headers['set-cookie']![0]).toMatch(/cp_admin=.*HttpOnly.*SameSite=Lax/i);
    const cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
    expect((await request(app).get('/api/admin/auth/me').set('cookie', cookie)).status).toBe(200);
    await request(app).post('/api/admin/auth/logout').set('cookie', cookie).set('content-type', 'application/json').send({});
    expect((await request(app).get('/api/admin/auth/me').set('cookie', cookie)).status).toBe(401);
  });

  it('requires JSON for admin mutations (CSRF hardening)', async () => {
    const { agent } = await adminAgent(db);
    const res = await agent.post('/api/admin/properties').set('content-type', 'application/x-www-form-urlencoded').send('title=x');
    expect(res.status).toBe(415);
  });

  it('creates, lists, updates and deactivates listings with validation', async () => {
    const { agent } = await adminAgent(db);
    const invalid = await agent.post('/api/admin/properties').send({ listing_code: 'CP-NEW-001', title: 'x', price_amount: -1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.length).toBeGreaterThan(0);

    const input = { listing_code: 'CP-NEW-001', title: '2BHK flat in Guindy', transaction_type: 'rent', property_type: 'apartment', locality: 'Guindy', bedrooms: 2, price_amount: 21000, price_period: 'monthly', furnishing: 'furnished', amenities: ['lift'], images: [] };
    const created = await agent.post('/api/admin/properties').send(input);
    expect(created.status).toBe(201);
    expect(created.body.property).toMatchObject({ listing_code: 'CP-NEW-001', is_demo: false, source_type: 'manual' });
    expect((await agent.post('/api/admin/properties').send(input)).status).toBe(409);

    const s = await chatSession(app);
    const before = await s.send('2BHK for rent in Guindy');
    expect(JSON.stringify(before.body.reply.cards)).toContain('CP-NEW-001');

    const id = created.body.property.id;
    const patched = await agent.patch(`/api/admin/properties/${id}`).send({ price_amount: 23000 });
    expect(patched.body.property.price_amount).toBe(23000);
    expect((await agent.patch(`/api/admin/properties/${id}`).send({ listing_code: 'HACK' })).status).toBe(400);

    const list = await agent.get('/api/admin/properties').query({ search: 'CP-NEW', page_size: 5 });
    expect(list.body).toMatchObject({ total: 1, page: 1, page_size: 5 });
    expect((await agent.get('/api/admin/properties').query({ page_size: 1000 })).status).toBe(400);

    const deact = await agent.post(`/api/admin/properties/${id}/deactivate`).send({});
    expect(deact.body.property.availability_status).toBe('deactivated');
    expect((await agent.post(`/api/admin/properties/${id}/deactivate`).send({})).status).toBe(409);
    const after = await s.send('2BHK for rent in Guindy');
    expect(JSON.stringify(after.body.reply.cards)).not.toContain('CP-NEW-001');
    expect((await request(app).get('/api/properties/CP-NEW-001')).status).toBe(404);
  });

  it('AC-09: historical lead links survive deactivation; leads can be updated and are audited', async () => {
    const { agent } = await adminAgent(db);
    const s = await chatSession(app);
    await s.send('3BHK for rent in Adyar');
    await s.send('call me back about the first one');
    await s.send('My name is Ravi, 9123456780');

    const leads = await agent.get('/api/admin/leads').query({ status: 'new' });
    expect(leads.status).toBe(200);
    const lead = leads.body.items.find((l: { customer_name: string }) => l.customer_name === 'Ravi');
    expect(lead).toMatchObject({ enquiry_type: 'callback', listing_code: 'CP-DEMO-009', customer_phone: '9123456780' });

    await agent.post(`/api/admin/properties/${lead.property_id}/deactivate`).send({});
    const detail = await agent.get(`/api/admin/leads/${lead.id}`);
    expect(detail.body.property).toMatchObject({ listing_code: 'CP-DEMO-009', availability_status: 'deactivated' });
    expect(detail.body.requirements.summary).toEqual(expect.arrayContaining(['for rent', '3BHK', 'in Adyar']));
    expect(detail.body.recent_messages.length).toBeGreaterThanOrEqual(4);

    const upd = await agent.patch(`/api/admin/leads/${lead.id}`).send({ status: 'contacted', assigned_agent: 'Anita', notes: 'Called, wants Sunday visit' });
    expect(upd.body.lead).toMatchObject({ status: 'contacted', assigned_agent: 'Anita' });
    expect((await agent.patch(`/api/admin/leads/${lead.id}`).send({ status: 'confirmed' })).status).toBe(400);
    const audit = await db.query<{ action: string; details_json: Record<string, unknown> }>(
      `SELECT action, details_json FROM audit_events WHERE entity_id = $1`,
      [lead.id],
    );
    expect(audit.rows.find((a) => a.action === 'lead.update')?.details_json).toMatchObject({ status_from: 'new', status_to: 'contacted' });

    const overview = await agent.get('/api/admin/overview');
    expect(overview.body).toMatchObject({ active_properties: expect.any(Number), new_leads: expect.any(Number), visit_requests: expect.any(Number) });
  });

  it('imports CSV with a dry run and a validation report', async () => {
    const { agent } = await adminAgent(db);
    const csv = fs.readFileSync(path.resolve(__dirname, '../../docs/sample-import.csv'), 'utf8');
    const dry = await agent.post('/api/admin/properties/import').send({ csv, dry_run: true });
    expect(dry.body.report).toMatchObject({ dryRun: true, valid: 2, imported: 0, errors: [] });
    const real = await agent.post('/api/admin/properties/import').send({ csv, dry_run: false });
    expect(real.body.report.imported).toBe(2);
    const again = await agent.post('/api/admin/properties/import').send({ csv, dry_run: false });
    expect(again.body.report).toMatchObject({ imported: 0 });
    expect(again.body.report.errors).toHaveLength(2);
  });
});

describe('AC-10: data persists across restart', () => {
  it('listings, requirements, messages and leads survive closing and reopening the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-persist-'));
    try {
      let fileDb = await createDb({ pgliteDataDir: dir });
      await migrate(fileDb);
      await seedDemo(fileDb);
      let fileApp = createApp({ db: fileDb, env: testEnv, ai: new RulesProvider() });
      const s = await chatSession(fileApp);
      await s.send('2BHK for rent in Velachery under 25k');
      await s.send('callback for the first one');
      await fileDb.close();

      fileDb = await createDb({ pgliteDataDir: dir });
      await migrate(fileDb);
      fileApp = createApp({ db: fileDb, env: testEnv, ai: new RulesProvider() });
      const hist = await request(fileApp).get(`/api/chat/sessions/${s.session_id}/messages`).set('authorization', `Bearer ${s.token}`);
      expect(hist.status).toBe(200);
      expect(hist.body.messages).toHaveLength(4);
      expect(hist.body.requirements).toMatchObject({ transaction_type: 'rent', bedrooms: 2, budget_max: 25000 });
      const leads = await fileDb.query<{ n: number }>('SELECT count(*)::int AS n FROM leads');
      expect(leads.rows[0]!.n).toBe(1);
      const props = await fileDb.query<{ n: number }>('SELECT count(*)::int AS n FROM properties');
      expect(props.rows[0]!.n).toBe(36);
      await fileDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open an embedded database that another live process holds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lock-'));
    try {
      // Simulate another live process (the parent of this test runner).
      fs.writeFileSync(path.join(dir, '.cp-process.lock'), String(process.ppid));
      await expect(createDb({ pgliteDataDir: dir })).rejects.toThrow(/in use by another process/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
