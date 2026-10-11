import { withDb, run } from './_db.js';

run(() =>
  withDb(async (db) => {
    console.log(`✔ Database (${db.kind}) is migrated and up to date.`);
  }),
);
