import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { AiError, type AiProvider } from '../src/ai/provider.js';
import { RulesProvider, interpretWithRules } from '../src/ai/rules.js';
import { InterpretationSchema } from '../src/ai/schemas.js';
import type { Card } from '../src/domain/cards.js';
import { messagesRepo, requirementsRepo } from '../src/repositories/conversations.repo.js';
import { leadsRepo } from '../src/repositories/leads.repo.js';
import { propertiesRepo } from '../src/repositories/properties.repo.js';
import { handleCustomerMessage } from '../src/services/conversation.service.js';
import { deps, makeDb, newConversation } from './helpers.js';
import { conversationsRepo, type Conversation } from '../src/repositories/conversations.repo.js';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(async () => {
  await db.close();
});

/** Sends a message and returns the reply body, cards and current requirements. */
async function say(conv: Conversation, text: string, ai: AiProvider = new RulesProvider()) {
  const fresh = (await conversationsRepo.getById(db, conv.id))!;
  const { reply } = await handleCustomerMessage(deps(db, ai), fresh, text);
  const cards = (reply.metadata_json.cards ?? []) as Card[];
  const { requirements } = await requirementsRepo.get(db, conv.id);
  const props = cards.find((c) => c.type === 'properties');
  return {
    body: reply.body,
    cards,
    requirements,
    codes: props && props.type === 'properties' ? props.items.map((i) => i.listing_code) : [],
    meta: reply.metadata_json,
  };
}

describe('search-to-enquiry journey (rule-based interpreter)', () => {
  let conv: Conversation;
  beforeAll(async () => {
    conv = await newConversation(db);
  });

  it('CHAT-03: asks rent-or-buy before presenting results', async () => {
    const r = await say(conv, '2BHK in Velachery under 25k');
    expect(r.body).toMatch(/rent or to buy/i);
    expect(r.codes).toEqual([]);
    expect(r.cards[0]).toMatchObject({ type: 'quick_replies' });
  });

  it('AC-01: saves validated requirements and returns only eligible matches', async () => {
    const r = await say(conv, 'for rent');
    expect(r.requirements).toMatchObject({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 });
    expect(r.codes.length).toBeGreaterThan(0);
    expect(r.codes).not.toContain('CP-DEMO-006');
    for (const code of r.codes) expect(r.body).toContain(code);
  });

  it('AC-02: "Only furnished ones" adds the filter and keeps the rest', async () => {
    const r = await say(conv, 'Only furnished ones.');
    expect(r.requirements).toMatchObject({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000, furnishing: 'furnished' });
    expect(r.codes).toEqual(['CP-DEMO-002', 'CP-DEMO-005']);
  });

  it('AC-03: a new budget keeps location, transaction type and BHK', async () => {
    const r = await say(conv, 'Actually my budget is ₹30,000.');
    expect(r.requirements).toMatchObject({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 30000, furnishing: 'furnished' });
    expect(r.codes).toContain('CP-DEMO-004');
  });

  it('AC-06: "the second one" resolves against the current result set', async () => {
    const list = await say(conv, 'show me the listings again for rent');
    const second = list.codes[1]!;
    const r = await say(conv, 'tell me about the second one');
    expect(r.body).toContain(second);
    expect(r.cards[0]).toMatchObject({ type: 'property_detail', item: { listing_code: second } });
  });

  it('AC-04: an unknown pet policy is stated as not recorded', async () => {
    // CP-DEMO-005 has pet_policy = unknown
    const r = await say(conv, 'Does CP-DEMO-005 allow pets?');
    expect(r.body).toMatch(/pet policy isn't recorded for CP-DEMO-005/i);
    expect(r.body).toMatch(/ask the team/i);
    expect(r.body).not.toMatch(/pets are allowed|pets are not allowed/i);
  });

  it('CHAT-05: "show cheaper ones" lowers the budget without losing location and BHK', async () => {
    await say(conv, 'show me the listings again for rent');
    const r = await say(conv, 'show cheaper ones');
    expect(r.requirements.budget_max).toBeLessThan(30000);
    expect(r.requirements).toMatchObject({ locality_terms: ['Velachery'], bedrooms: 2 });
  });

  it('AC-07: a callback on a selected listing persists a lead with the right property', async () => {
    const list = await say(conv, 'show me the listings again for rent');
    const first = list.codes[0]!;
    const r = await say(conv, 'Can I get a callback for the first one?');
    expect(r.cards[0]).toMatchObject({ type: 'lead', lead: { enquiry_type: 'callback', status: 'new', listing_code: first }, needs_contact: true });
    const leads = await leadsRepo.listForConversation(db, conv.id);
    const p = (await propertiesRepo.getByCode(db, first))!;
    expect(leads.at(-1)).toMatchObject({ property_id: p.id, enquiry_type: 'callback', status: 'new' });
  });

  it('AC-08: a site visit is recorded as requested, never confirmed', async () => {
    const r = await say(conv, 'I want to visit the first one on Saturday at 11am');
    expect(r.cards[0]).toMatchObject({ type: 'lead', lead: { enquiry_type: 'site_visit', status: 'visit_requested' } });
    expect(r.body).toMatch(/not a confirmed booking/i);
    expect(r.body).not.toMatch(/\b(is|has been) (confirmed|booked)\b/i);
    const lead = (await leadsRepo.listForConversation(db, conv.id)).at(-1)!;
    expect(lead.status).toBe('visit_requested');
    expect(lead.preferred_time_text).toMatch(/saturday at 11am/);
  });

  it('a repeated enquiry for the same listing does not create a duplicate lead', async () => {
    const before = (await leadsRepo.listForConversation(db, conv.id)).length;
    await say(conv, 'I want to visit the first one on Saturday at 11am');
    expect((await leadsRepo.listForConversation(db, conv.id)).length).toBe(before);
  });

  it('captures contact details shared in chat', async () => {
    const r = await say(conv, 'My name is Priya and my number is 98765 43210');
    expect(r.body).toMatch(/ending 3210/);
  });

  it('CHAT-08: compares two listings by displayed number', async () => {
    await say(conv, 'show me the listings again for rent');
    const r = await say(conv, 'compare 1 and 2');
    expect(r.cards[0]).toMatchObject({ type: 'compare' });
  });

  it('shortlisting is idempotent', async () => {
    const a = await say(conv, 'shortlist the first one');
    const b = await say(conv, 'shortlist the first one');
    expect(a.body).toMatch(/Saved/);
    expect(b.body).toMatch(/already on your shortlist/);
  });

  it('refuses to resolve a result number that does not exist', async () => {
    const r = await say(conv, 'tell me about the fifth one');
    expect(r.body).toMatch(/no #5/);
  });
});

describe('zero results and unknown facts', () => {
  it('AC-05: explains no exact match without inventing listings', async () => {
    const conv = await newConversation(db);
    const r = await say(conv, '5BHK for rent in Velachery under 10k');
    expect(r.body).toMatch(/No stored listings match/);
    expect(r.codes).toEqual([]);
    expect(r.body).not.toMatch(/CP-DEMO/);
  });

  it('FAQ answers only configured facts and escalates unknown ones', async () => {
    const conv = await newConversation(db);
    expect((await say(conv, 'how do site visits work?')).body).toMatch(/not booked until they confirm/);
    expect((await say(conv, 'what is your brokerage?')).body).toMatch(/don't have that information recorded/);
  });
});

describe('AC-13: sessions are isolated', () => {
  it('requirements, results and history do not leak between conversations', async () => {
    const a = await newConversation(db);
    const b = await newConversation(db);
    await say(a, '2BHK for rent in Velachery under 25k');
    await say(b, '3BHK to buy in Adyar');
    expect((await requirementsRepo.get(db, a.id)).requirements.locality_terms).toEqual(['Velachery']);
    expect((await requirementsRepo.get(db, b.id)).requirements.locality_terms).toEqual(['Adyar']);
    const historyB = await messagesRepo.list(db, b.id);
    expect(historyB.some((m) => m.body.includes('Velachery under 25k'))).toBe(false);
    // "the first one" in B must not resolve to A's results
    const r = await say(b, 'tell me about the first one');
    expect(r.body).not.toContain('Velachery');
  });
});

describe('AC-11: AI provider failures', () => {
  const failing = (err: Error): AiProvider => ({ name: 'mock', interpret: vi.fn().mockRejectedValue(err) });

  it('falls back to the deterministic interpreter on a provider timeout', async () => {
    const conv = await newConversation(db);
    const r = await say(conv, '2BHK for rent in Velachery under 25k', failing(new AiError('timeout', 'timeout', true)));
    expect(r.codes.length).toBeGreaterThan(0);
    expect(r.meta.ai).toMatchObject({ fallback: true, error: 'timeout' });
  });

  it('returns a safe retry message (and keeps the customer message) when nothing can interpret it', async () => {
    const conv = await newConversation(db);
    const r = await say(conv, 'hmm so like the thing', failing(new AiError('invalid_output', 'bad json', false)));
    expect(r.body).toMatch(/try again/i);
    expect(r.meta.retryable).toBe(true);
    expect(r.codes).toEqual([]);
    const history = await messagesRepo.list(db, conv.id);
    expect(history[0]).toMatchObject({ direction: 'inbound', body: 'hmm so like the thing' });
  });

  it('rejects schema-invalid model output (unknown intent / tool)', async () => {
    const conv = await newConversation(db);
    const bad: AiProvider = { name: 'mock', interpret: async () => ({ intent: 'run_sql', sql: 'DROP TABLE properties' }) as never };
    const r = await say(conv, 'xyzzy', bad);
    expect(r.meta.retryable).toBe(true);
    expect((await db.query('SELECT 1 FROM properties LIMIT 1')).rows.length).toBe(1);
  });

  it('discards a model rewrite that introduces facts not in the tool results', async () => {
    const conv = await newConversation(db);
    const sneaky: AiProvider = {
      name: 'mock',
      interpret: async (input) => InterpretationSchema.parse({ ...interpretWithRules(input), language: 'mixed' }),
      compose: async () => 'Great news! CP-DEMO-999 is available for ₹9,000/month and your visit is confirmed.',
    };
    const r = await say(conv, '2BHK for rent in Velachery under 25k', sneaky);
    expect(r.body).not.toContain('CP-DEMO-999');
    expect(r.meta.ai).toMatchObject({ composed: false });
  });

  it('accepts a grounded rewrite (e.g. a translation that keeps codes and amounts)', async () => {
    const conv = await newConversation(db);
    const polite: AiProvider = {
      name: 'mock',
      interpret: async (input) => InterpretationSchema.parse({ ...interpretWithRules(input), language: 'mixed' }),
      compose: async ({ draft }) => `Sure! ${draft.split('\n')[0]}`,
    };
    const r = await say(conv, '2BHK for rent in Velachery under 25k', polite);
    expect(r.body.startsWith('Sure!')).toBe(true);
    expect(r.meta.ai).toMatchObject({ composed: true });
  });
});

describe('compose policy', () => {
  it('does not call the model to rephrase English replies by default (saves quota)', async () => {
    const conv = await newConversation(db);
    const compose = vi.fn().mockResolvedValue('rewritten');
    const ai: AiProvider = { name: 'mock', interpret: async (input) => interpretWithRules(input), compose };
    const r = await say(conv, '2BHK for rent in Velachery under 25k', ai);
    expect(compose).not.toHaveBeenCalled();
    expect(r.meta.ai).toMatchObject({ composed: false });
  });
});

describe('AC-15: duplicate submissions', () => {
  it('the same client message id returns the original reply without reprocessing', async () => {
    const conv = await newConversation(db);
    const d = deps(db);
    const first = await handleCustomerMessage(d, conv, 'I need a 2BHK for rent in Adyar', { clientMessageId: 'msg-123456' });
    const again = await handleCustomerMessage(d, conv, 'I need a 2BHK for rent in Adyar', { clientMessageId: 'msg-123456' });
    expect(again.duplicate).toBe(true);
    expect(again.reply.id).toBe(first.reply.id);
    expect((await messagesRepo.list(db, conv.id)).length).toBe(2);
  });
});
