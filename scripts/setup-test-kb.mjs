#!/usr/bin/env node
// Idempotent setup for the test_kb mock consuming-repo fixture.
// Run from the kb repo root: `npm run setup:test-kb`
// Full rationale and manual steps: docs/test-kb.md
//
// Encodes the exact commands verified by hand when test_kb was first created.
// If ../test_kb already exists, this is a no-op.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_KB = resolve(KB, '..', 'test_kb');
const REPO = 'mcap91/test_kb';
const SURFACES = ['issues', 'initiatives', 'decisions', 'sources', 'areas', 'plans', 'handoffs'];

function sh(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}
function quiet(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { return false; }
}

if (existsSync(resolve(TEST_KB, '.git'))) {
  console.log(`test_kb already exists at ${TEST_KB} — nothing to do.`);
  process.exit(0);
}

console.log(`Creating test_kb fixture at ${TEST_KB}`);
mkdirSync(TEST_KB, { recursive: true });

// Bootstrap the consuming-repo wiki scaffold using this kb checkout.
sh(`npm run wiki -- bootstrap --dir "${TEST_KB}" --repo ${REPO}`, { cwd: KB });

// Keep required wiki surface dirs in git (git cannot track empty directories).
for (const s of SURFACES) {
  const d = resolve(TEST_KB, 'wiki', s);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, '.gitkeep'), '');
}

writeFileSync(
  resolve(TEST_KB, 'README.md'),
  '# test_kb\n\nMock consuming-repo fixture for the kb toolkit. Recreate with ' +
    '`npm run setup:test-kb` from a kb checkout. See `kb/docs/test-kb.md`.\n',
);

sh(`git -C "${TEST_KB}" init -b main`);
sh(`git -C "${TEST_KB}" add -A`);
sh(`git -C "${TEST_KB}" commit -m "chore: bootstrap test_kb mock consuming-repo fixture"`);

if (!quiet('gh --version')) {
  console.log('gh not found — created test_kb locally only. Create the remote per docs/test-kb.md.');
  process.exit(0);
}

if (quiet(`gh repo view ${REPO}`)) {
  // Remote already exists — just wire it up and push.
  sh(`git -C "${TEST_KB}" remote add origin https://github.com/${REPO}.git`);
  sh(`git -C "${TEST_KB}" push -u origin main`);
} else {
  sh(
    `gh repo create ${REPO} --private --source="${TEST_KB}" --remote=origin --push ` +
      `--description "Mock consuming repo fixture for kb integration testing"`,
  );
}

console.log('test_kb ready.');
