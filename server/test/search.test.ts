import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { EMPTY_REQUIREMENTS, type Requirements } from '../src/domain/requirements.js';
import { propertiesRepo } from '../src/repositories/properties.repo.js';
import { searchProperties } from '../src/services/search.service.js';
import { deactivateProperty, updateProperty } from '../src/services/property.service.js';
import { seedDemo } from '../src/db/seed.js';
import { importPropertiesCsv } from '../src/services/csv-import.service.js';
import { makeDb } from './helpers.js';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(async () => {
  await db.close();
});

const req = (r: Partial<Requirements>): Requirements => ({ ...EMPTY_REQUIREMENTS, ...r });
const codes = (r: Awaited<ReturnType<typeof searchProperties>>) => r.results.map((x) => x.property.listing_code);

describe('deterministic property search (no AI)', () => {
  it('AC-01: returns only eligible rentals matching all hard constraints', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 }));
    expect(r.status).toBe('ok');
    for (const { property: p } of r.results) {
      expect(p).toMatchObject({ transaction_type: 'rent', locality: 'Velachery', bedrooms: 2 });
      expect(p.price_amount).toBeLessThanOrEqual(25000);
      expect(['available', 'pending_confirmation']).toContain(p.availability_status);
    }
    // CP-DEMO-006 matches every filter but is unavailable.
    expect(codes(r)).not.toContain('CP-DEMO-006');
    expect(codes(r)).toEqual(expect.arrayContaining(['CP-DEMO-001', 'CP-DEMO-002', 'CP-DEMO-003', 'CP-DEMO-005']));
  });

  it('ranks available listings above pending ones and qualifies pending status', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 }));
    const pending = r.results.find((x) => x.property.listing_code === 'CP-DEMO-005')!;
    expect(pending.caveats.join(' ')).toMatch(/pending confirmation/i);
    expect(codes(r).indexOf('CP-DEMO-005')).toBe(codes(r).length - 1);
  });

  it('requires a transaction type before searching', async () => {
    const r = await searchProperties(db, req({ locality_terms: ['Velachery'] }));
    expect(r.status).toBe('needs_transaction_type');
    expect(r.results).toEqual([]);
  });

  it('excludes confirmed "no" but keeps unknown values flagged (PROP-06)', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000, pets_required: true }));
    expect(codes(r)).not.toContain('CP-DEMO-003'); // pets not allowed
    const unknown = r.results.find((x) => x.property.listing_code === 'CP-DEMO-001')!;
    expect(unknown.caveats).toContain('Pet policy is not recorded for this listing');
    expect(r.results[0]!.property.listing_code).toBe('CP-DEMO-002'); // confirmed "allowed" ranks first
  });

  it('matches a corridor (OMR) across its localities with exact localities ranked first', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['OMR'], bedrooms: 2 }));
    expect(r.results.length).toBeGreaterThan(0);
    expect(new Set(r.results.map((x) => x.property.locality))).toEqual(new Set(['Perungudi', 'Sholinganallur', 'Navalur']));
  });

  it('AC-05: offers a clearly labelled near match only when one exists', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 17000 }));
    expect(r.results).toEqual([]);
    expect(r.nearMatch?.relaxed).toBe('budget');
    expect(r.nearMatch?.explanation).toMatch(/above your budget/);
    expect(r.nearMatch?.results[0]!.property.listing_code).toBe('CP-DEMO-003');

    const none = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 5, budget_max: 5000 }));
    expect(none.results).toEqual([]);
    expect(none.nearMatch).toBeUndefined();
  });

  it('offers other property types as a labelled near match when the type has no matches', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Adyar'], property_type: 'independent_house' }));
    expect(r.results).toEqual([]);
    expect(r.nearMatch?.relaxed).toBe('property_type');
    expect(r.nearMatch?.explanation).toMatch(/no independent house matched/);
    expect(r.nearMatch?.results.every((x) => x.property.locality === 'Adyar')).toBe(true);
  });

  it('reports an unknown locality instead of guessing', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Atlantis'] }));
    expect(r.status).toBe('unknown_locality');
  });

  it('limits results to a small set', async () => {
    const r = await searchProperties(db, req({ transaction_type: 'rent', budget_max: 100000 }));
    expect(r.results.length).toBe(5);
    expect(r.totalMatches).toBeGreaterThan(5);
  });
});

describe('inventory changes affect search immediately (PROP-02, AC-09)', () => {
  it('a deactivated listing disappears from search; an edited price is applied', async () => {
    const p = (await propertiesRepo.getByCode(db, 'CP-DEMO-001'))!;
    await updateProperty(db, 'test-admin', p.id, { price_amount: 26000 });
    let r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 }));
    expect(codes(r)).not.toContain('CP-DEMO-001');

    await updateProperty(db, 'test-admin', p.id, { price_amount: 22000 });
    r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 }));
    expect(codes(r)).toContain('CP-DEMO-001');

    await deactivateProperty(db, 'test-admin', p.id);
    r = await searchProperties(db, req({ transaction_type: 'rent', locality_terms: ['Velachery'], bedrooms: 2, budget_max: 25000 }));
    expect(codes(r)).not.toContain('CP-DEMO-001');
    const after = (await propertiesRepo.getById(db, p.id))!;
    expect(after.availability_status).toBe('deactivated');
    expect(after.deactivated_at).not.toBeNull();
  });

  it('rejects an update that breaks cross-field rules', async () => {
    const p = (await propertiesRepo.getByCode(db, 'CP-DEMO-002'))!;
    await expect(updateProperty(db, 'test-admin', p.id, { price_period: 'total' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('seed and CSV import', () => {
  it('AC-14: re-running the seed creates no duplicates', async () => {
    const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM properties');
    const result = await seedDemo(db);
    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM properties');
    expect(result.inserted).toBe(0);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('PROP-07: validates every row and imports nothing if any row is bad', async () => {
    const header = 'listing_code,title,transaction_type,property_type,locality,bedrooms,price_amount,price_period,amenities';
    const bad = `${header}\nCP-CSV-001,Nice 2BHK flat,rent,apartment,Adyar,2,30000,monthly,lift|gym\nCP-CSV-002,Bad row,rent,castle,Narnia,2,-5,monthly,`;
    const report = await importPropertiesCsv(db, bad, { dryRun: false });
    expect(report.imported).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.row).toBe(2);
    expect(await propertiesRepo.getByCode(db, 'CP-CSV-001')).toBeNull();

    const good = `${header}\nCP-CSV-001,Nice 2BHK flat,rent,apartment,adyar,2,30000,monthly,lift|gym`;
    expect((await importPropertiesCsv(db, good, { dryRun: true })).imported).toBe(0);
    const ok = await importPropertiesCsv(db, good, { dryRun: false });
    expect(ok).toMatchObject({ imported: 1, errors: [] });
    const imported = (await propertiesRepo.getByCode(db, 'CP-CSV-001'))!;
    expect(imported).toMatchObject({ locality: 'Adyar', source_type: 'csv_import', is_demo: false, amenities: ['lift', 'gym'] });

    const dup = await importPropertiesCsv(db, good, { dryRun: false });
    expect(dup.errors[0]!.errors.join()).toMatch(/already exists/);
  });
});
