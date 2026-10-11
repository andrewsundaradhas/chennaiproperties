import { seedDemo } from '../db/seed.js';
import { withDb, run } from './_db.js';

run(() =>
  withDb(async (db) => {
    const { inserted, skipped } = await seedDemo(db);
    console.log(`✔ Demo seed complete: ${inserted} listing(s) inserted, ${skipped} already present (left unchanged).`);
    console.log('  All seeded listings are SAMPLE DATA (is_demo = true, codes CP-DEMO-###).');
  }),
);
