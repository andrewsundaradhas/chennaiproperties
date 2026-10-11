import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemo } from '../src/db/seed.js';
import { TelegramClient, type TgUpdate } from '../src/channels/telegram/api.js';
import { TelegramBot, listingCaption, splitMessage } from '../src/channels/telegram/bot.js';
import { setupTelegram } from '../src/channels/telegram/index.js';
import { TelegramPoller } from '../src/channels/telegram/poller.js';
import { loadEnv } from '../src/config/env.js';
import { createApp } from '../src/http/app.js';
import { RulesProvider } from '../src/ai/rules.js';
import { conversationsRepo, customersRepo, messagesRepo, requirementsRepo } from '../src/repositories/conversations.repo.js';
import { leadsRepo } from '../src/repositories/leads.repo.js';
import { deps, makeDb } from './helpers.js';

const TOKEN = `123456789:${'A'.repeat(35)}`;
const PUBLIC_DIR = path.resolve(__dirname, '../../web/public');

type Call = { method: string; params: Record<string, unknown>; files: string[] };

/** In-memory stand-in for api.telegram.org. Records every call; responses are overridable. */
class FakeTelegram {
  calls: Call[] = [];
  handlers: Record<string, (p: Record<string, unknown>) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>> = {};
  private messageId = 1000;

  fetch = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const params: Record<string, unknown> = {};
    const files: string[] = [];
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') params[k] = tryJson(v);
        else files.push(k);
      }
    } else if (typeof init.body === 'string') Object.assign(params, JSON.parse(init.body));
    this.calls.push({ method, params, files });
    const h = this.handlers[method];
    if (h) {
      const r = await h(params);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    const result =
      method === 'sendPhoto'
        ? { message_id: this.messageId++, photo: [{ file_id: 'small' }, { file_id: `file-${this.messageId}` }] }
        : method === 'getMe'
          ? { id: 999, is_bot: true, first_name: 'CP', username: 'cp_test_bot' }
          : method === 'getWebhookInfo'
            ? { url: '' }
            : { message_id: this.messageId++ };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;

  sent(chatId?: number) {
    return this.calls.filter((c) => ['sendMessage', 'sendPhoto'].includes(c.method) && (chatId === undefined || c.params.chat_id === chatId));
  }
  texts(chatId?: number) {
    return this.sent(chatId).map((c) => String(c.params.text ?? c.params.caption ?? ''));
  }
  allText(chatId?: number) {
    return this.texts(chatId).join('\n---\n');
  }
  buttons(chatId?: number): string[] {
    return this.sent(chatId).flatMap((c) => {
      const kb = (c.params.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
      return kb.flat().map((b) => b.callback_data);
    });
  }
  reset() {
    this.calls = [];
  }
}
const tryJson = (v: string) => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

let nextUpdate = 1;
const user = (id: number) => ({ id, is_bot: false, first_name: `User${id}` });
const chat = (id: number) => ({ id, type: 'private' as const });
const textUpdate = (userId: number, text: string, updateId = nextUpdate++): TgUpdate => ({
  update_id: updateId,
  message: { message_id: updateId, from: user(userId), chat: chat(userId), date: 0, text },
});
const tapUpdate = (userId: number, data: string, updateId = nextUpdate++): TgUpdate => ({
  update_id: updateId,
  callback_query: { id: `cq${updateId}`, from: user(userId), message: { message_id: 1, chat: chat(userId) }, data },
});

function makeBot(db: Db, fake: FakeTelegram, extra: { maxMessagesPerMinute?: number } = {}) {
  const client = new TelegramClient({ token: TOKEN, fetchImpl: fake.fetch, maxRetries: 2 });
  return new TelegramBot({ db, conversation: deps(db), client, botId: '999', publicDir: PUBLIC_DIR, ...extra });
}

async function telegramConversation(db: Db, userId: number) {
  const customer = await customersRepo.upsert(db, 'telegram', String(userId));
  return (await conversationsRepo.latestActiveForCustomer(db, customer.id))!;
}

let db: Db;
let fake: FakeTelegram;
let bot: TelegramBot;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
function fresh(extra: { maxMessagesPerMinute?: number } = {}) {
  fake = new FakeTelegram();
  bot = makeBot(db, fake, extra);
}

describe('commands', () => {
  it('/start introduces the bot with a main menu; /help lists commands', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(101, '/start'));
    expect(fake.allText()).toMatch(/Welcome to ChennaiProperties AI/);
    expect(fake.allText()).toMatch(/sample demonstration data/);
    expect(fake.buttons()).toEqual(expect.arrayContaining(['m:rent', 'm:sale', 'cmp', 'help']));
    fake.reset();
    await bot.handleUpdate(textUpdate(101, '/help@cp_test_bot'));
    expect(fake.allText()).toMatch(/\/reset/);
    expect(fake.allText()).toMatch(/\/cancel/);
  });

  it('/properties offers rent or buy; unknown commands are handled', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(102, '/properties'));
    expect(fake.buttons()).toEqual(['m:rent', 'm:sale']);
    fake.reset();
    await bot.handleUpdate(textUpdate(102, '/sudo_admin'));
    expect(fake.allText()).toMatch(/don't know that command/);
  });

  it('/cancel with nothing pending says so', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(103, '/cancel'));
    expect(fake.allText()).toMatch(/nothing to cancel/);
  });

  it('/reset asks for confirmation, then starts a fresh context without deleting history or leads', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(104, '2BHK for rent in Velachery under 25000'));
    await bot.handleUpdate(tapUpdate(104, 'cb:CP-DEMO-002'));
    const before = await telegramConversation(db, 104);
    fake.reset();
    await bot.handleUpdate(textUpdate(104, '/reset'));
    expect(fake.buttons()).toEqual(['rs:y', 'rs:n']);
    expect((await telegramConversation(db, 104)).id).toBe(before.id); // nothing changed yet
    await bot.handleUpdate(tapUpdate(104, 'rs:y'));
    expect(await conversationsRepo.latestActiveForCustomer(db, before.customer_id)).toBeNull();
    await bot.handleUpdate(textUpdate(104, 'hi'));
    const after = await telegramConversation(db, 104);
    expect(after.id).not.toBe(before.id);
    expect((await requirementsRepo.get(db, after.id)).requirements.locality_terms).toEqual([]);
    expect((await messagesRepo.list(db, before.id)).length).toBeGreaterThan(0);
    expect(await leadsRepo.listForConversation(db, before.id)).toHaveLength(1);
  });
});

describe('natural-language search through the shared conversation service', () => {
  it('rental search returns database listings as photo cards with validated buttons', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(201, 'Find a 2BHK for rent in Velachery under 25000'));
    const text = fake.allText(201);
    expect(text).toMatch(/listings for rent, 2BHK, in Velachery/);
    expect(text).toMatch(/CP-DEMO-001/);
    expect(text).not.toMatch(/CP-DEMO-006/); // unavailable
    expect(text).toMatch(/Pending confirmation/); // CP-DEMO-005 qualified
    const photos = fake.calls.filter((c) => c.method === 'sendPhoto');
    expect(photos.length).toBeGreaterThan(0);
    expect(photos[0]!.files).toEqual(['photo']); // local PNG uploaded (Telegram can't show SVG)
    expect(fake.texts(201).some((t) => t.includes('CP-DEMO-003'))).toBe(true); // no photo → text card
    const buttons = fake.buttons(201);
    expect(buttons).toEqual(expect.arrayContaining(['d:CP-DEMO-001', 's:CP-DEMO-001', 'cb:CP-DEMO-001', 'v:CP-DEMO-001']));
    for (const b of buttons) expect(Buffer.byteLength(b)).toBeLessThanOrEqual(64);
  });

  it('caches uploaded photos by file_id', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(202, '2BHK for rent in Velachery under 25000'));
    await bot.handleUpdate(textUpdate(202, 'show them again for rent'));
    const uploads = fake.calls.filter((c) => c.method === 'sendPhoto' && c.files.length > 0);
    const byId = fake.calls.filter((c) => c.method === 'sendPhoto' && typeof c.params.photo === 'string');
    expect(uploads.length).toBeGreaterThan(0);
    expect(byId.length).toBeGreaterThan(0);
  });

  it('sale search', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(203, 'I want to buy a 3BHK in Velachery'));
    expect(fake.allText(203)).toMatch(/CP-DEMO-026/);
    expect(fake.allText(203)).toMatch(/for sale/);
  });

  it('keeps preferences across messages and updates only what changed', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(204, '2BHK for rent in Velachery under 25000'));
    await bot.handleUpdate(textUpdate(204, 'Show me furnished properties'));
    await bot.handleUpdate(textUpdate(204, 'actually my budget is 30000'));
    const conv = await telegramConversation(db, 204);
    expect((await requirementsRepo.get(db, conv.id)).requirements).toMatchObject({
      transaction_type: 'rent',
      locality_terms: ['Velachery'],
      bedrooms: 2,
      furnishing: 'furnished',
      budget_max: 30000,
    });
    await bot.handleUpdate(textUpdate(204, 'I want to buy a villa instead'));
    expect((await requirementsRepo.get(db, conv.id)).requirements).toMatchObject({ transaction_type: 'sale', property_type: 'villa' });
  });

  it('asks rent-or-buy when ambiguous, with tappable answers that work', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(205, '2BHK in Adyar under 40k'));
    expect(fake.allText(205)).toMatch(/rent or to buy/);
    const qr = fake.buttons(205).find((b) => b.startsWith('qr:'))!;
    expect(qr).toMatch(/^qr:[0-9a-f-]{36}:0$/);
    fake.reset();
    await bot.handleUpdate(tapUpdate(205, qr));
    expect(fake.allText(205)).toMatch(/CP-DEMO-008/);
  });

  it('no results: says so and offers to adjust a filter, never invents listings', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(206, '5BHK for rent in Velachery under 10000'));
    const text = fake.allText(206);
    expect(text).toMatch(/No stored listings match/);
    expect(text).not.toMatch(/CP-DEMO-\d+/);
    expect(fake.buttons(206).some((b) => b.startsWith('qr:'))).toBe(true);
  });

  it('unknown property facts are stated as not recorded', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(207, 'Does CP-DEMO-005 allow pets?'));
    expect(fake.allText(207)).toMatch(/pet policy isn't recorded for CP-DEMO-005/i);
  });

  it('"the second one" resolves against this user\'s current results', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(208, '2BHK for rent in Velachery under 25000'));
    const conv = await telegramConversation(db, 208);
    const second = (await import('../src/repositories/properties.repo.js')).propertiesRepo;
    const p = (await second.getManyByIds(db, conv.last_result_ids))[1]!;
    fake.reset();
    await bot.handleUpdate(textUpdate(208, 'Show me the second property again'));
    expect(fake.allText(208)).toContain(p.listing_code);
  });
});

describe('buttons, shortlist and leads', () => {
  it('details button shows stored fields, including what is not recorded', async () => {
    fresh();
    await bot.handleUpdate(tapUpdate(301, 'd:CP-DEMO-005'));
    expect(fake.calls[0]!.method).toBe('answerCallbackQuery');
    const text = fake.allText(301);
    expect(text).toMatch(/CP-DEMO-005/);
    expect(text).toMatch(/Pets: not recorded/);
    expect(text).toMatch(/Parking: available/);
  });

  it('rejects malformed, unknown or deactivated listing ids in button data', async () => {
    fresh();
    await bot.handleUpdate(tapUpdate(302, 'd:../../etc/passwd'));
    expect(fake.allText(302)).toMatch(/no longer valid/);
    fake.reset();
    await bot.handleUpdate(tapUpdate(302, 'cb:CP-NOPE-999'));
    expect(fake.allText(302)).toMatch(/couldn't find an active listing/);
    expect(await leadsRepo.listForConversation(db, (await telegramConversation(db, 302)).id)).toHaveLength(0);
    fake.reset();
    await bot.handleUpdate(tapUpdate(302, 'admin:delete_all'));
    expect(fake.allText(302)).toMatch(/didn't recognise that button/);
  });

  it('quick-reply buttons cannot reach another user\'s messages', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(303, '2BHK in Adyar under 40k'));
    const other = fake.buttons(303).find((b) => b.startsWith('qr:'))!;
    fake.reset();
    await bot.handleUpdate(tapUpdate(304, other));
    expect(fake.allText(304)).toMatch(/expired/);
  });

  it('shortlist is idempotent and compare needs two saved listings', async () => {
    fresh();
    await bot.handleUpdate(tapUpdate(305, 's:CP-DEMO-001'));
    await bot.handleUpdate(tapUpdate(305, 's:CP-DEMO-001'));
    expect(fake.allText(305)).toMatch(/Saved CP-DEMO-001/);
    expect(fake.allText(305)).toMatch(/already on your shortlist/);
    fake.reset();
    await bot.handleUpdate(tapUpdate(305, 'cmp'));
    expect(fake.allText(305)).toMatch(/Save at least two/);
    await bot.handleUpdate(tapUpdate(305, 's:CP-DEMO-002'));
    fake.reset();
    await bot.handleUpdate(tapUpdate(305, 'cmp'));
    expect(fake.allText(305)).toMatch(/Side by side/);
    expect(fake.allText(305)).toMatch(/CP-DEMO-001[\s\S]*CP-DEMO-002/);
  });

  it('callback creates a lead, asks for the phone via Telegram contact sharing, and accepts only the user\'s own number', async () => {
    fresh();
    await bot.handleUpdate(tapUpdate(306, 'cb:CP-DEMO-002'));
    const conv = await telegramConversation(db, 306);
    const [lead] = await leadsRepo.listForConversation(db, conv.id);
    expect(lead).toMatchObject({ enquiry_type: 'callback', status: 'new' });
    const markup = fake.sent(306).at(-1)!.params.reply_markup as { keyboard: { request_contact?: boolean }[][] };
    expect(markup.keyboard[0]![0]!.request_contact).toBe(true);
    expect((await telegramConversation(db, 306)).channel_state).toMatchObject({ awaiting: 'contact' });

    fake.reset();
    await bot.handleUpdate({
      update_id: nextUpdate++,
      message: { message_id: 9, from: user(306), chat: chat(306), date: 0, contact: { phone_number: '+91 98400 11111', first_name: 'Someone', user_id: 999999 } },
    });
    expect(fake.allText(306)).toMatch(/share your own number/);
    let customer = (await customersRepo.getById(db, conv.customer_id))!;
    expect(customer.phone).toBeNull();

    await bot.handleUpdate({
      update_id: nextUpdate++,
      message: { message_id: 10, from: user(306), chat: chat(306), date: 0, contact: { phone_number: '+919840012345', first_name: 'Karthik', user_id: 306 } },
    });
    customer = (await customersRepo.getById(db, conv.customer_id))!;
    expect(customer).toMatchObject({ phone: '9840012345', display_name: 'Karthik', consent_status: 'granted', external_channel: 'telegram' });
    expect(fake.allText(306)).toMatch(/ending 2345/);
    expect((await telegramConversation(db, 306)).channel_state).toEqual({});
    // Telegram leads show up for admins with their channel.
    const list = await leadsRepo.list(db, { limit: 50, offset: 0 });
    expect(list.items.find((l) => l.id === lead!.id)).toMatchObject({ channel: 'telegram', listing_code: 'CP-DEMO-002', customer_phone: '9840012345' });
  });

  it('/cancel clears a pending phone request', async () => {
    fresh();
    await bot.handleUpdate(tapUpdate(307, 'cb:CP-DEMO-004'));
    fake.reset();
    await bot.handleUpdate(textUpdate(307, '/cancel'));
    expect(fake.allText(307)).toMatch(/Cancelled/);
    expect(fake.sent(307).at(-1)!.params.reply_markup).toEqual({ remove_keyboard: true });
    expect((await telegramConversation(db, 307)).channel_state).toEqual({});
  });

  it('site visit is recorded as requested, never confirmed', async () => {
    fresh();
    await bot.handleUpdate(textUpdate(308, '2BHK for rent in Velachery under 25000'));
    await bot.handleUpdate(textUpdate(308, 'I want to visit the first one this weekend'));
    const conv = await telegramConversation(db, 308);
    const lead = (await leadsRepo.listForConversation(db, conv.id)).at(-1)!;
    expect(lead).toMatchObject({ enquiry_type: 'site_visit', status: 'visit_requested' });
    expect(lead.preferred_time_text).toMatch(/this weekend/);
    const text = fake.allText(308);
    expect(text).toMatch(/not a confirmed booking/);
    expect(text).not.toMatch(/\b(is|has been) (confirmed|booked)\b/i);
  });
});

describe('reliability and safety', () => {
  it('duplicate updates are processed once (no duplicate messages or leads)', async () => {
    fresh();
    const u = tapUpdate(401, 'cb:CP-DEMO-001');
    await bot.handleUpdate(u);
    await bot.handleUpdate(u);
    const conv = await telegramConversation(db, 401);
    expect(await leadsRepo.listForConversation(db, conv.id)).toHaveLength(1);
    expect((await messagesRepo.list(db, conv.id)).filter((m) => m.direction === 'inbound')).toHaveLength(1);
  });

  it('two users are isolated', async () => {
    fresh();
    await Promise.all([
      bot.enqueue(textUpdate(402, '2BHK for rent in Velachery under 25000')),
      bot.enqueue(textUpdate(403, '3BHK to buy in Adyar')),
    ]);
    const a = await telegramConversation(db, 402);
    const b = await telegramConversation(db, 403);
    expect(a.id).not.toBe(b.id);
    expect((await requirementsRepo.get(db, a.id)).requirements.locality_terms).toEqual(['Velachery']);
    expect((await requirementsRepo.get(db, b.id)).requirements.locality_terms).toEqual(['Adyar']);
    expect(fake.allText(403)).not.toMatch(/Velachery/);
    expect(fake.allText(402)).not.toMatch(/Adyar/);
  });

  it('web chat sessions are never merged with Telegram identities', async () => {
    const web = await customersRepo.upsert(db, 'web', '402');
    const tg = await customersRepo.upsert(db, 'telegram', '402');
    expect(web.id).not.toBe(tg.id);
  });

  it('ignores group chats, bots, and non-text media politely', async () => {
    fresh();
    await bot.handleUpdate({ update_id: nextUpdate++, message: { message_id: 1, from: user(404), chat: { id: -5, type: 'group' }, date: 0, text: '2bhk rent velachery' } });
    expect(fake.sent()).toHaveLength(0);
    await bot.handleUpdate({ update_id: nextUpdate++, message: { message_id: 2, from: { ...user(405), is_bot: true }, chat: chat(405), date: 0, text: 'hi' } });
    expect(fake.sent()).toHaveLength(0);
    await bot.handleUpdate({ update_id: nextUpdate++, message: { message_id: 3, from: user(404), chat: chat(404), date: 0, sticker: {} } });
    expect(fake.allText(404)).toMatch(/only read text messages/);
  });

  it('rate-limits a flooding user and warns once', async () => {
    fresh({ maxMessagesPerMinute: 2 });
    for (let i = 0; i < 5; i++) await bot.handleUpdate(textUpdate(406, 'hi'));
    expect(fake.texts(406).filter((t) => /very quickly/.test(t))).toHaveLength(1);
  });

  it('truncates very long input and splits long output safely', async () => {
    expect(splitMessage('a'.repeat(9000), 4000).map((p) => p.length)).toEqual([4000, 4000, 1000]);
    expect(splitMessage('line\n'.repeat(2000), 4000).every((p) => p.length <= 4000)).toBe(true);
    fresh();
    await bot.handleUpdate(textUpdate(407, `2BHK for rent in Adyar ${'x'.repeat(5000)}`));
    const conv = await telegramConversation(db, 407);
    const inbound = (await messagesRepo.list(db, conv.id)).find((m) => m.direction === 'inbound')!;
    expect(inbound.body.length).toBeLessThanOrEqual(2000);
  });

  it('escapes HTML in listing captions', () => {
    const caption = listingCaption(
      { index: 1, listing_code: 'X-1', title: '<b>evil</b> & co', availability_status: 'available', price_label: '₹1', transaction_type: 'rent', locality: 'Adyar', bedrooms: 1, property_type: 'apartment', area_sqft: null, furnishing: 'unknown', reasons: [], caveats: [], parking: 'unknown', pet_policy: 'unknown', amenities: [], description: null, is_demo: true, updated_at: new Date().toISOString() } as never,
      true,
    );
    expect(caption).toContain('&lt;b&gt;evil&lt;/b&gt; &amp; co');
  });

  it('retries transient Telegram failures (5xx, 429 retry_after) but not client errors', async () => {
    fresh();
    let n = 0;
    fake.handlers.sendMessage = () => (++n === 1 ? { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } } : { body: { ok: true, result: { message_id: 1 } } });
    await bot.handleUpdate(textUpdate(408, '/help'));
    expect(fake.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);

    fresh();
    let m = 0;
    fake.handlers.sendMessage = () => (++m === 1 ? { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } } } : { body: { ok: true, result: { message_id: 1 } } });
    await bot.handleUpdate(textUpdate(408, '/help'));
    expect(fake.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);

    fresh();
    fake.handlers.sendMessage = () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
    await bot.handleUpdate(textUpdate(408, '/help'));
    // 1 failed send + 1 best-effort apology, no retries
    expect(fake.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
  });

  it('falls back to a text card when Telegram rejects a photo', async () => {
    fresh();
    fake.handlers.sendPhoto = () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: IMAGE_PROCESS_FAILED' } });
    await bot.handleUpdate(tapUpdate(409, 'd:CP-DEMO-002'));
    expect(fake.calls.filter((c) => c.method === 'sendMessage').some((c) => String(c.params.text).includes('CP-DEMO-002'))).toBe(true);
  });

  it('never logs the bot token', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l) => void lines.push(String(l)));
    vi.spyOn(console, 'error').mockImplementation((l) => void lines.push(String(l)));
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      const failing = (async () => {
        throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
      }) as unknown as typeof fetch;
      const client = new TelegramClient({ token: TOKEN, fetchImpl: failing, maxRetries: 1 });
      const b = new TelegramBot({ db, conversation: deps(db), client, botId: '999' });
      await b.handleUpdate(textUpdate(410, '/start'));
      await expect(client.call('getMe')).rejects.toThrow(/network error/);
    } finally {
      process.env.LOG_LEVEL = prev;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN.split(':')[1]);
  });
});

describe('configuration, polling and webhook', () => {
  const env = (extra: Record<string, string>) => loadEnv({ NODE_ENV: 'test', AI_PROVIDER: 'rules', ...extra });

  it('missing token: bot disabled with setup instructions; web app still works', async () => {
    const tg = setupTelegram({ db, env: env({}), conversation: deps(db) });
    expect(tg.status()).toMatchObject({ state: 'disabled', reason: expect.stringMatching(/TELEGRAM_BOT_TOKEN/) });
    const app = createApp({ db, env: env({}), ai: new RulesProvider(), telegram: tg });
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).post('/api/chat/sessions').send({})).status).toBe(201);
  });

  it('malformed token is rejected without calling Telegram', async () => {
    const f = new FakeTelegram();
    const tg = setupTelegram({ db, env: env({ TELEGRAM_BOT_TOKEN: 'not-a-token' }), conversation: deps(db), fetchImpl: f.fetch });
    expect(tg.status()).toMatchObject({ state: 'disabled', reason: expect.stringMatching(/format/) });
    expect(f.calls).toHaveLength(0);
  });

  it('invalid (revoked) token disables the bot instead of crashing', async () => {
    const f = new FakeTelegram();
    f.handlers.getMe = () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    const tg = setupTelegram({ db, env: env({ TELEGRAM_BOT_TOKEN: TOKEN }), conversation: deps(db), fetchImpl: f.fetch });
    expect(await tg.start()).toMatchObject({ state: 'disabled', reason: expect.stringMatching(/rejected/) });
    await tg.stop();
  });

  it('refuses to long-poll while a webhook is configured', async () => {
    const f = new FakeTelegram();
    f.handlers.getWebhookInfo = () => ({ body: { ok: true, result: { url: 'https://example.com/hook' } } });
    const tg = setupTelegram({ db, env: env({ TELEGRAM_BOT_TOKEN: TOKEN }), conversation: deps(db), fetchImpl: f.fetch });
    expect(await tg.start()).toMatchObject({ state: 'disabled', reason: expect.stringMatching(/webhook/) });
    expect(f.calls.some((c) => c.method === 'getUpdates')).toBe(false);
  });

  it('polls, persists the offset, holds a single-consumer lease and stops gracefully', async () => {
    const f = new FakeTelegram();
    let polls = 0;
    f.handlers.getUpdates = async (p) => {
      polls++;
      if (polls === 1) return { body: { ok: true, result: [textUpdate(501, '/start', 7001)] } };
      if (polls === 2) {
        expect(p.offset).toBe(7002);
        return { status: 409, body: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } };
      }
      return { body: { ok: true, result: [] } };
    };
    const client = new TelegramClient({ token: TOKEN, fetchImpl: f.fetch });
    const poller = new TelegramPoller({ db, client, makeBot: () => new TelegramBot({ db, conversation: deps(db), client, botId: '999' }), backoffMs: () => 5 });
    await poller.start();
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    expect(poller.status).toMatchObject({ state: 'running', username: 'cp_test_bot' });
    expect(f.calls.some((c) => c.method === 'setMyCommands')).toBe(true);

    // A second process cannot take over while the lease is held.
    const f2 = new FakeTelegram();
    const client2 = new TelegramClient({ token: TOKEN, fetchImpl: f2.fetch });
    const second = new TelegramPoller({ db, client: client2, makeBot: () => new TelegramBot({ db, conversation: deps(db), client: client2, botId: '999' }) });
    await second.start();
    await vi.waitFor(() => expect(second.status.state).toBe('waiting_for_lease'));
    expect(f2.calls.some((c) => c.method === 'getUpdates')).toBe(false);
    await second.stop();

    await poller.stop();
    const state = await db.query<{ last_update_id: string; lease_owner: string | null }>(`SELECT last_update_id, lease_owner FROM telegram_bot_state WHERE bot_id = '999'`);
    expect(Number(state.rows[0]!.last_update_id)).toBe(7001);
    expect(state.rows[0]!.lease_owner).toBeNull(); // released on shutdown
    expect(f.allText(501)).toMatch(/Welcome/);
  });

  it('webhook mode verifies the secret header and processes updates', async () => {
    const f = new FakeTelegram();
    const e = env({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: 'super-secret-value-123' });
    const tg = setupTelegram({ db, env: e, conversation: deps(db), fetchImpl: f.fetch });
    await tg.start();
    const app = createApp({ db, env: e, ai: new RulesProvider(), telegram: tg });
    const update = textUpdate(601, '/start');
    expect((await request(app).post('/api/telegram/webhook').send(update)).status).toBe(401);
    expect((await request(app).post('/api/telegram/webhook').set('x-telegram-bot-api-secret-token', 'wrong-secret-value-12').send(update)).status).toBe(401);
    const ok = await request(app).post('/api/telegram/webhook').set('x-telegram-bot-api-secret-token', 'super-secret-value-123').send(update);
    expect(ok.status).toBe(200);
    await tg.stop();
    expect(f.allText(601)).toMatch(/Welcome/);
  });
});

describe('persistence across restart', () => {
  it('conversation context survives closing and reopening the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tg-'));
    try {
      let fileDb = await createDb({ pgliteDataDir: dir });
      await migrate(fileDb);
      await seedDemo(fileDb);
      let f = new FakeTelegram();
      await makeBot(fileDb, f).handleUpdate(textUpdate(701, '2BHK for rent in Velachery under 25000', 9001));
      await fileDb.close();

      fileDb = await createDb({ pgliteDataDir: dir });
      await migrate(fileDb);
      f = new FakeTelegram();
      const restarted = makeBot(fileDb, f);
      await restarted.handleUpdate(textUpdate(701, '2BHK for rent in Velachery under 25000', 9001)); // redelivered
      expect(f.sent()).toHaveLength(0);
      await restarted.handleUpdate(textUpdate(701, 'only furnished ones', 9002));
      const conv = await telegramConversation(fileDb, 701);
      expect((await requirementsRepo.get(fileDb, conv.id)).requirements).toMatchObject({ locality_terms: ['Velachery'], bedrooms: 2, furnishing: 'furnished' });
      expect(f.allText(701)).toMatch(/CP-DEMO-002/);
      await fileDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
