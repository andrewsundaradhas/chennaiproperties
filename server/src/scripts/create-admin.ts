// Creates (or resets the password of) a local admin user. No default password is ever shipped:
// pass one via ADMIN_PASSWORD or let the script generate a random one and print it once.
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { adminRepo } from '../repositories/admin.repo.js';
import { withDb, run } from './_db.js';

run(async () => {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin' } },
  });
  const email = values.email ?? env().ADMIN_BOOTSTRAP_EMAIL;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Provide an email: npm run admin:create -- --email you@example.com (or set ADMIN_BOOTSTRAP_EMAIL)');
  }
  if (values.role !== 'admin' && values.role !== 'agent') throw new Error('--role must be admin or agent');
  const provided = process.env.ADMIN_PASSWORD;
  if (provided !== undefined && provided.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const password = provided ?? randomToken(15);

  await withDb(async (db) => {
    await adminRepo.upsertLocal(db, {
      email,
      display_name: values.name ?? email.split('@')[0]!,
      role: values.role as 'admin' | 'agent',
      password_hash: await hashPassword(password),
    });
  });
  console.log(`✔ Admin user ready: ${email.toLowerCase()}`);
  if (!provided) console.log(`  Generated password (shown once — store it safely): ${password}`);
});
