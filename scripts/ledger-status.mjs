// Ledger built-status check (IN-0011 ruling 2026-10-28 #4: build status is read
// from disk, never typed). Parses the Rules table in wiki/sources/SRC-0024.md and
// reports each `Where built` path as BUILT or MISSING. Informational; exits 0.
//
// Usage: node scripts/ledger-status.mjs   (from the kb repo root or anywhere)

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = resolve(kbRoot, 'wiki/sources/SRC-0024.md');
const text = readFileSync(ledgerPath, 'utf-8');

const rulesSection = text.split(/^## Rules$/m)[1]?.split(/^## /m)[0];
if (!rulesSection) {
  console.error('ledger-status: no "## Rules" section found in SRC-0024.md');
  process.exit(1);
}

const rows = rulesSection
  .split('\n')
  .filter((l) => l.startsWith('|'))
  .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()))
  .filter((cells) => cells.length >= 7 && cells[0] !== 'ID' && !/^-+$/.test(cells[0]));

let built = 0;
let missing = 0;
let none = 0;

for (const cells of rows) {
  const [id, , , , , where] = cells;
  if (/^none\b/i.test(where) || where === '—' || where === '') {
    none += 1;
    console.log(`${id.padEnd(9)} none`);
    continue;
  }
  const paths = where
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .filter((t) => t.includes('/'));
  for (const raw of paths) {
    const p = raw.startsWith('~') ? resolve(homedir(), raw.slice(2)) : resolve(kbRoot, raw);
    const ok = existsSync(p);
    if (ok) built += 1;
    else missing += 1;
    console.log(`${id.padEnd(9)} ${ok ? 'BUILT  ' : 'MISSING'} ${raw}`);
  }
}

console.log(`\n${built} built, ${missing} missing, ${none} rules with no guard yet`);
