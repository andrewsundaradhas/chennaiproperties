import type { Db } from './client.js';
import { DEMO_FAQS, DEMO_PROPERTIES } from './seed-data.js';
import { propertiesRepo } from '../repositories/properties.repo.js';

/** Idempotent: existing listing codes are left untouched (admin edits to demo rows survive). */
export async function seedDemo(db: Db): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const p of DEMO_PROPERTIES) {
      const { rows } = await tx.query('SELECT 1 FROM properties WHERE listing_code = $1', [p.listing_code]);
      if (rows.length > 0) {
        skipped++;
        continue;
      }
      await propertiesRepo.insert(tx, p, { source_type: 'demo_seed', is_demo: true });
      inserted++;
    }
    for (const f of DEMO_FAQS) {
      await tx.query(
        `INSERT INTO business_faqs (key, question, answer, is_demo) VALUES ($1, $2, $3, true)
         ON CONFLICT (key) DO NOTHING`,
        [f.key, f.question, f.answer],
      );
    }
  });
  return { inserted, skipped };
}

/**
 * Removes all customer/conversation/lead data and demo listings, then re-seeds.
 * Non-demo (manually created or imported) listings are kept unless they are referenced by nothing.
 */
export async function resetDemo(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM leads');
    await tx.query('DELETE FROM shortlists');
    await tx.query('DELETE FROM customers'); // cascades conversations, messages, requirements
    await tx.query('DELETE FROM properties WHERE is_demo = true'); // cascades images
    await tx.query("DELETE FROM audit_events WHERE actor_type <> 'admin'");
  });
  await seedDemo(db);
}
