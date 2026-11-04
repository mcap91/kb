#!/usr/bin/env node
// Fails when package-lock.json is out of sync with the workspace package.json files.
// Run on the host with `npm run check:lockfile`; it is part of kb's validation command.
// Not a pretest hook: dispatch jails mount the clone read-only, and this check writes package-lock.json.
//
// Regenerates the lockfile offline from the npm cache, compares it with the copy on
// disk, and always restores the original bytes, so the check never edits the tree.
// `npm ci --dry-run` is not enough: it passed on the drift this check exists to catch
// (a relicense and a new workspace dependency that never reached the lockfile).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = resolve(KB, 'package-lock.json');

const before = readFileSync(LOCK);
let after;
try {
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: KB, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  after = readFileSync(LOCK);
} finally {
  writeFileSync(LOCK, before);
}

if (!before.equals(after)) {
  console.error(
    'check-lockfile.mjs: package-lock.json is out of sync with package.json. ' +
      'Run `npm install` and commit the updated package-lock.json.',
  );
  process.exit(1);
}
