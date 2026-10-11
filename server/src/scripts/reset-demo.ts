import { resetDemo } from '../db/seed.js';
import { withDb, run } from './_db.js';

run(async () => {
  if (!process.argv.includes('--yes')) {
    console.log(
      'This deletes ALL customers, conversations, messages, shortlists and leads, plus all demo listings,\n' +
        'then re-seeds the demo listings. Manually created / imported listings are kept.\n\n' +
        'Re-run with --yes to confirm:  npm run db:reset-demo -- --yes',
    );
    process.exit(1);
  }
  await withDb(async (db) => {
    await resetDemo(db);
    console.log('✔ Demo data reset.');
  });
});
