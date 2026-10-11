import { describe, expect, it } from 'vitest';
import { checkGrounded } from '../src/ai/guard.js';
import { detectLanguage, interpretWithRules, parseAmount } from '../src/ai/rules.js';
import { InterpretationSchema } from '../src/ai/schemas.js';
import { formatInr, formatPrice } from '../src/domain/format.js';
import { resolveLocalityTerms, localitiesInCorridor } from '../src/domain/localities.js';
import { PropertyInputSchema } from '../src/domain/property.js';
import {
  EMPTY_REQUIREMENTS,
  mergeRequirements,
  RequirementsPatchSchema,
  type Requirements,
} from '../src/domain/requirements.js';
import { normalisePhone } from '../src/services/conversation.service.js';
import { DEMO_PROPERTIES } from '../src/db/seed-data.js';

const interp = (message: string, requirements: Requirements = EMPTY_REQUIREMENTS, lastResults = 0) =>
  interpretWithRules({
    message,
    history: [],
    requirements,
    lastResults: Array.from({ length: lastResults }, (_, i) => ({ index: i + 1, listing_code: `CP-DEMO-00${i + 1}`, title: 'x' })),
    faqKeys: [],
  });

describe('requirement schema and merge semantics', () => {
  const base: Requirements = { ...EMPTY_REQUIREMENTS, transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 };

  it('changing the budget keeps location, transaction type and BHK (AC-03)', () => {
    const { requirements, changed } = mergeRequirements(base, {}, RequirementsPatchSchema.parse({ set: { budget_max: 30000 } }));
    expect(requirements).toMatchObject({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 30000 });
    expect(changed).toEqual(['budget_max']);
  });

  it('adding furnishing keeps other preferences (AC-02)', () => {
    const { requirements } = mergeRequirements(base, {}, RequirementsPatchSchema.parse({ set: { furnishing: 'furnished' } }));
    expect(requirements).toMatchObject({ ...base, furnishing: 'furnished' });
  });

  it('explicit clear resets only the cleared field', () => {
    const { requirements } = mergeRequirements(base, { bedrooms: 'explicit' }, RequirementsPatchSchema.parse({ clear: ['bedrooms'] }));
    expect(requirements.bedrooms).toBeNull();
    expect(requirements.budget_max).toBe(25000);
  });

  it('records confidence and drops an incoherent minimum', () => {
    const { requirements, confidence } = mergeRequirements(
      { ...base, budget_min: 20000 },
      {},
      RequirementsPatchSchema.parse({ set: { budget_max: 15000 }, confidence: { budget_max: 'inferred' } }),
    );
    expect(requirements.budget_min).toBeNull();
    expect(confidence.budget_max).toBe('inferred');
  });

  it('rejects unsupported enum values', () => {
    expect(RequirementsPatchSchema.safeParse({ set: { transaction_type: 'lease' } }).success).toBe(false);
    expect(RequirementsPatchSchema.safeParse({ set: { amenities: ['helipad'] } }).success).toBe(false);
  });
});

describe('locality aliases', () => {
  it('resolves aliases and spelling variants to canonical names', () => {
    expect(resolveLocalityTerms(['velacheri', 'T Nagar', 'annanagar']).localities).toEqual(['Velachery', 'T. Nagar', 'Anna Nagar']);
  });
  it('treats OMR as a corridor, not a single place', () => {
    const r = resolveLocalityTerms(['OMR']);
    expect(r.localities).toEqual([]);
    expect(r.corridors).toEqual(['OMR']);
    expect(localitiesInCorridor('OMR')).toEqual(expect.arrayContaining(['Perungudi', 'Sholinganallur', 'Navalur']));
  });
  it('reports unknown terms instead of guessing', () => {
    expect(resolveLocalityTerms(['Atlantis']).unknown).toEqual(['Atlantis']);
  });
});

describe('price formatting', () => {
  it('uses Indian grouping and explicit periods', () => {
    expect(formatInr(2500000)).toBe('₹25,00,000');
    expect(formatPrice(22000, 'monthly')).toBe('₹22,000/month');
    expect(formatPrice(7800000, 'total')).toBe('₹78 lakh');
    expect(formatPrice(12500000, 'total')).toBe('₹1.25 crore');
    expect(formatPrice(6900000, 'negotiable')).toBe('₹69 lakh (negotiable)');
  });
  it('parses common amount shorthands', () => {
    expect(parseAmount('25k')).toBe(25000);
    expect(parseAmount('25,000')).toBe(25000);
    expect(parseAmount('80 lakhs')).toBe(8000000);
    expect(parseAmount('1.2 cr')).toBe(12000000);
  });
});

describe('rule-based interpretation (deterministic fallback)', () => {
  it('extracts the AC-01 request', () => {
    const r = interp('I need a 2BHK for rent in Velachery under ₹25,000, with parking.');
    expect(r.intent).toBe('search');
    expect(r.requirements.set).toMatchObject({ transaction_type: 'rent', bedrooms: 2, budget_max: 25000, locality_terms: ['Velachery'], parking_required: true });
  });
  it('understands every example prompt shown in the chat UI without a model', () => {
    const examples = [
      'I need a 2BHK for rent in Velachery under ₹25,000, with parking',
      'Show me 3BHK flats to buy in Adyar',
      'Pet-friendly house for rent in Anna Nagar',
      'Rentals on OMR under 22k',
    ];
    for (const ex of examples) {
      const r = interp(ex);
      expect(r.intent, ex).toBe('search');
      expect(r.requirements.set.transaction_type, ex).toBeDefined();
      expect(r.requirements.set.locality_terms?.length, ex).toBeGreaterThan(0);
    }
  });
  it('does not guess rent vs sale for "under 30k"', () => {
    const r = interp('2bhk in Adyar under 30k');
    expect(r.requirements.set.transaction_type).toBeUndefined();
    expect(r.requirements.set.budget_max).toBe(30000);
  });
  it('maps follow-ups to refinements', () => {
    const existing: Requirements = { ...EMPTY_REQUIREMENTS, transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2 };
    expect(interp('Only furnished ones.', existing)).toMatchObject({ intent: 'refine', requirements: { set: { furnishing: 'furnished' } } });
    expect(interp('Actually my budget is ₹30,000.', existing)).toMatchObject({ intent: 'refine', requirements: { set: { budget_max: 30000 } } });
    expect(interp('show cheaper ones', existing)).toMatchObject({ intent: 'refine', relative_budget: 'cheaper' });
    expect(interp('Any property type is fine', { ...existing, property_type: 'independent_house' })).toMatchObject({ intent: 'refine', requirements: { clear: ['property_type'] } });
    expect(interp('actually i can stretch to 30 thousand', existing)).toMatchObject({ intent: 'refine', requirements: { set: { budget_max: 30000 } } });
  });
  it('resolves ordinal references and listing codes', () => {
    expect(interp('Does the second one allow pets?', EMPTY_REQUIREMENTS, 3)).toMatchObject({
      intent: 'property_question',
      property_refs: [{ kind: 'index', index: 2 }],
      question_fields: ['pet_policy'],
    });
    expect(interp('tell me about CP-DEMO-012').property_refs).toEqual([{ kind: 'code', code: 'CP-DEMO-012' }]);
  });
  it('recognises enquiries, visits, compare and contact details', () => {
    expect(interp('Can I get a callback for the first one?', EMPTY_REQUIREMENTS, 2).intent).toBe('callback');
    const visit = interp('I want to visit the 2nd one on Saturday at 11am', EMPTY_REQUIREMENTS, 2);
    expect(visit.intent).toBe('site_visit');
    expect(visit.preferred_time_text).toContain('saturday at 11am');
    expect(interp('compare 1 and 3', EMPTY_REQUIREMENTS, 3).intent).toBe('compare');
    expect(interp('My name is Priya, 98765 43210')).toMatchObject({ intent: 'provide_contact', contact: { name: 'Priya', phone: '9876543210' } });
  });
  it('detects Tanglish and Tamil script independently of the model', () => {
    expect(detectLanguage('Anna Nagar la 2BHK vaadagai ku venum, 30k kulla')).toBe('mixed');
    expect(detectLanguage('வேளச்சேரியில் வீடு')).toBe('ta');
    expect(detectLanguage('2BHK in Adyar')).toBe('en');
  });
  it('flags Tamil script / Tanglish as non-English', () => {
    expect(interp('Velachery la 2BHK vaadagai venum').language).toBe('mixed');
    expect(interp('Velachery la 2BHK vaadagai venum').requirements.set.transaction_type).toBe('rent');
    expect(interp('Anna Nagar la 2BHK vaadagai ku venum, 30k kulla').requirements.set).toMatchObject({ budget_max: 30000, bedrooms: 2, transaction_type: 'rent' });
    expect(interp('2bhk rent adyar 25k max').requirements.set.budget_max).toBe(25000);
  });
  it('produces schema-valid output for arbitrary input', () => {
    for (const msg of ['', '???', 'asdf qwer', 'x'.repeat(2000), 'DROP TABLE properties;']) {
      expect(InterpretationSchema.safeParse(interp(msg)).success).toBe(true);
    }
  });
});

describe('grounding guard', () => {
  const draft = 'Here are 2 listings: 1. CP-DEMO-001 — ₹22,000/month 2. CP-DEMO-002 — ₹24,500/month';
  it('accepts a faithful rephrase', () => {
    expect(checkGrounded(draft, 'I found 2 options: CP-DEMO-001 at ₹22,000/month and CP-DEMO-002 at ₹24,500/month.').ok).toBe(true);
  });
  it('rejects invented listings, prices and booking claims', () => {
    expect(checkGrounded(draft, 'Also CP-DEMO-099 is great.').ok).toBe(false);
    expect(checkGrounded(draft, 'CP-DEMO-001 is ₹19,000/month.').ok).toBe(false);
    expect(checkGrounded('Request recorded for CP-DEMO-001.', 'Your visit to CP-DEMO-001 is confirmed!').ok).toBe(false);
  });
});

describe('demo data and property validation', () => {
  it('has 20–50 listings with stable, unique codes and required edge cases', () => {
    expect(DEMO_PROPERTIES.length).toBeGreaterThanOrEqual(20);
    expect(DEMO_PROPERTIES.length).toBeLessThanOrEqual(50);
    expect(new Set(DEMO_PROPERTIES.map((p) => p.listing_code)).size).toBe(DEMO_PROPERTIES.length);
    expect(DEMO_PROPERTIES.every((p) => /^CP-DEMO-\d{3}$/.test(p.listing_code))).toBe(true);
    const has = (fn: (p: (typeof DEMO_PROPERTIES)[number]) => boolean) => DEMO_PROPERTIES.some(fn);
    expect(has((p) => p.availability_status === 'unavailable')).toBe(true);
    expect(has((p) => p.availability_status === 'pending_confirmation')).toBe(true);
    expect(has((p) => p.images.length === 0)).toBe(true);
    expect(has((p) => p.pet_policy === 'unknown')).toBe(true);
    expect(has((p) => p.parking === 'not_available')).toBe(true);
    expect(has((p) => p.transaction_type === 'sale')).toBe(true);
  });
  it('rejects invalid prices, periods and localities', () => {
    const ok = DEMO_PROPERTIES[0]!;
    expect(PropertyInputSchema.safeParse({ ...ok, price_amount: 0 }).success).toBe(false);
    expect(PropertyInputSchema.safeParse({ ...ok, price_period: 'total' }).success).toBe(false); // rent must be monthly
    expect(PropertyInputSchema.safeParse({ ...ok, locality: 'Narnia' }).success).toBe(false);
    expect(PropertyInputSchema.safeParse({ ...ok, images: [{ image_url: 'javascript:alert(1)' }] }).success).toBe(false);
  });
  it('normalises Indian mobile numbers', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('12345')).toBeNull();
  });
});
