// Fails if any file git would commit contains something that looks like a credential.
// Runs over tracked + untracked-but-not-ignored files, so it also catches new files before `git add`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PATTERNS = [
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
  [/\bAQ\.[A-Za-z0-9_-]{30,}/, 'Google API key (AQ. format)'],
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/sb_publishable_[A-Za-z0-9_-]{10,}/, 'Supabase publishable key'],
  [/eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT (e.g. Supabase anon/service_role key)'],
  [/postgres(?:ql)?:\/\/[^\s:@/<>]+:(?!<)[^\s@/<>]+@/, 'Database URL with an inline password'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Private key'],
  [/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API secret key'],
];
const FORBIDDEN_FILES = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.(pem|key|p12|pfx)$/, /(^|\/)pgdata\//];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];
for (const file of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(file))) problems.push(`${file}: file type must never be committed`);
  if (!fs.existsSync(file) || fs.statSync(file).size > 2_000_000 || file.endsWith('package-lock.json')) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [re, label] of PATTERNS) if (re.test(line)) problems.push(`${file}:${i + 1}: possible ${label}`);
  });
}

if (problems.length) {
  console.error(`✖ Secret check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ Secret check passed (${files.length} files scanned)`);
