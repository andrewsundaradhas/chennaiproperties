import fs from 'node:fs';
import { importPropertiesCsv, CSV_COLUMNS } from '../services/csv-import.service.js';
import { withDb, run } from './_db.js';

run(async () => {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const commit = process.argv.includes('--commit');
  if (!file) {
    throw new Error(`Usage: npm run import:csv -- <file.csv> [--commit]\nColumns: ${CSV_COLUMNS.join(', ')}`);
  }
  const csv = fs.readFileSync(file, 'utf8');
  await withDb(async (db) => {
    const report = await importPropertiesCsv(db, csv, { dryRun: !commit });
    console.log(`Rows: ${report.totalRows}  valid: ${report.valid}  errors: ${report.errors.length}`);
    for (const e of report.errors) console.log(`  row ${e.row}${e.listing_code ? ` (${e.listing_code})` : ''}: ${e.errors.join('; ')}`);
    if (report.errors.length) {
      console.log('✖ Nothing imported — fix the errors above and retry.');
      process.exitCode = 1;
    } else if (!commit) console.log('✔ Dry run OK. Re-run with --commit to import.');
    else console.log(`✔ Imported ${report.imported} listing(s).`);
  });
});
