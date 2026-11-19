/**
 * PLN-0004 S0 Wave 2b — delivery gate + capture module tests.
 *
 * Covers delivery.ts (script-generating + result-parsing halves of the T6
 * delivery gate — the WK-0074 B4R protocol ported, not re-derived) and
 * capture.ts (T7-lite response doc writer + HO provenance write-back field
 * builder). Neither module executes anything; wave 3's pipeline.ts wires
 * script generation/execution/parsing together with wsl2.ts. No
 * personal/absolute paths appear in fixtures (WK-0043); secret fixtures use
 * well-known example-only values (e.g. AWS's own documented placeholder
 * access key), never real-looking live keys.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  scanSecrets,
  buildDeliveryScript,
  parseDeliveryOutput,
  buildStageScript,
  parseStageOutput,
  runStageScript,
  classifyStage,
  buildLandScript,
  parseLandOutput,
  buildQuarantineScript,
  STAGE_TEMP_PREFIX,
  STAGE_RAW_LISTING_FILENAME,
  STAGE_IGNORED_FILENAME,
  type StageResult,
  type DeliveryOutcome,
} from '../packages/dispatch-core/src/delivery.js';
import { execBash, MAX_BUFFER_BYTES } from '../packages/dispatch-core/src/exec-direct.js';
import { ENV_NAME } from '../packages/dispatch-core/src/repo-config.js';
import { buildInjectedValueScanFragment } from '../packages/dispatch-core/src/credentials.js';
import { writeResponseDoc, buildProvenanceWriteBack } from '../packages/dispatch-core/src/capture.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// delivery.ts — checkWriteScope
// ---------------------------------------------------------------------------

describe('delivery.ts — checkWriteScope', () => {
  it('passes a file under a scoped directory prefix', () => {
    const result = checkWriteScope(['src/foo.ts'], ['src/']);
    expect(result.ok).toBe(true);
  });

  it('fails a file outside every scoped prefix', () => {
    const result = checkWriteScope(['lib/foo.ts'], ['src/']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.offendingPaths).toEqual(['lib/foo.ts']);
  });

  it('matches an exact-path scope entry with no trailing slash', () => {
    const result = checkWriteScope(['tests/credentials.test.ts'], ['tests/credentials.test.ts']);
    expect(result.ok).toBe(true);
  });

  it('flags only the offending paths out of a mixed change set', () => {
    const result = checkWriteScope(['src/a.ts', 'lib/b.ts', 'src/c.ts'], ['src/']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.offendingPaths).toEqual(['lib/b.ts']);
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — scanSecrets
// ---------------------------------------------------------------------------

describe('delivery.ts — scanSecrets', () => {
  it('passes a clean diff', () => {
    const result = scanSecrets('diff --git a/src/foo.ts b/src/foo.ts\n+export const x = 1;\n');
    expect(result.ok).toBe(true);
  });

  it('catches an AWS access key id', () => {
    const result = scanSecrets('+const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.patterns).toContain('aws_access_key_id');
  });

  it('catches a bearer token', () => {
    const result = scanSecrets('+headers: { Authorization: "Bearer abc123DEF456.ghi789" }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.patterns).toContain('bearer_token');
  });

  it('catches a PEM private key block', () => {
    const result = scanSecrets(
      '+-----BEGIN PRIVATE KEY-----\n+MIIEvQIBADANBgkqhkiG\n+-----END PRIVATE KEY-----',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.patterns).toContain('pem_private_key');
  });

  it('catches an sk-style API key', () => {
    const result = scanSecrets('+const apiKey = "sk-abc123def456ghi789jkl012";');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.patterns).toContain('sk_style_api_key');
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — buildEnumerateScript / parseEnumerateOutput
// ---------------------------------------------------------------------------

describe('delivery.ts — buildEnumerateScript', () => {
  it('produces a valid bash script carrying the frozen git config', () => {
    const { scriptContent, scriptName } = buildEnumerateScript('/tmp/run/clone');
    expect(scriptContent).toContain('#!/bin/bash');
    expect(scriptContent).toContain('set -euo pipefail');
    expect(scriptContent).toContain(
      '-c core.autocrlf=false -c core.eol=lf -c core.hooksPath= -c core.fsmonitor=',
    );
    expect(scriptContent).toContain('cd "$CLONE_PATH"');
    expect(scriptContent).toContain('status --porcelain');
    expect(scriptContent).toContain('diff --name-status --diff-filter=R HEAD');
    expect(scriptContent).toContain('ls-files --others --exclude-standard');
    expect(scriptName).toBe('dispatch-enumerate.sh');
  });
});

describe('delivery.ts — parseEnumerateOutput', () => {
  it('parses status/rename/diff/untracked sections into a change set', () => {
    const stdout = [
      '---STATUS-START---',
      ' M modified.txt',
      'A  added.txt',
      'D  deleted.txt',
      'R  old.txt -> new.txt',
      '?? untracked1.txt',
      '---STATUS-END---',
      '---RENAME-START---',
      'R100\told.txt\tnew.txt',
      '---RENAME-END---',
      '---DIFF-START---',
      'diff --git a/added.txt b/added.txt',
      '+hello',
      '---DIFF-END---',
      '---UNTRACKED-START---',
      'untracked1.txt',
      '---UNTRACKED-END---',
      '',
    ].join('\n');

    const result = parseEnumerateOutput(stdout);
    expect([...result.changedFiles].sort()).toEqual(
      ['added.txt', 'deleted.txt', 'modified.txt', 'new.txt', 'old.txt'].sort(),
    );
    expect(result.untrackedFiles).toEqual(['untracked1.txt']);
    expect(result.diff).toContain('diff --git a/added.txt b/added.txt');
    expect(result.diff).toContain('+hello');
  });

  it('returns empty arrays and an empty diff for a clean, no-op enumerate', () => {
    const stdout = [
      '---STATUS-START---',
      '---STATUS-END---',
      '---RENAME-START---',
      '---RENAME-END---',
      '---DIFF-START---',
      '---DIFF-END---',
      '---UNTRACKED-START---',
      '---UNTRACKED-END---',
    ].join('\n');

    const result = parseEnumerateOutput(stdout);
    expect(result.changedFiles).toEqual([]);
    expect(result.untrackedFiles).toEqual([]);
    expect(result.diff).toBe('');
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — buildDeliveryScript / parseDeliveryOutput
// ---------------------------------------------------------------------------

describe('delivery.ts — buildDeliveryScript', () => {
  it('produces a script with pinned committer env vars and CAS logic', () => {
    const { scriptContent, scriptName } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
    });

    expect(scriptContent).toContain('GIT_COMMITTER_NAME="kb-dispatch"');
    expect(scriptContent).toContain('GIT_COMMITTER_EMAIL="dispatch@kb.local"');
    expect(scriptContent).toContain('GIT_AUTHOR_NAME="kb-dispatch"');
    expect(scriptContent).toContain('GIT_AUTHOR_EMAIL="dispatch@kb.local"');
    expect(scriptContent).toContain(
      '-c core.autocrlf=false -c core.eol=lf -c core.hooksPath= -c core.fsmonitor=',
    );
    expect(scriptContent).toContain('GIT_INDEX_FILE="$DELIVERY_IDX"');
    expect(scriptContent).toContain('read-tree "$BASE_SHA"');
    expect(scriptContent).toContain('write-tree');
    expect(scriptContent).toContain('commit-tree "$TREE" -p "$BASE_SHA"');
    expect(scriptContent).toContain('refs/heads/dispatch/$HANDOFF_ID');
    expect(scriptContent).toContain('IDEMPOTENT');
    expect(scriptContent).toContain('CONFLICT:');
    expect(scriptContent).toContain("HANDOFF_ID='HO-0002'");
    expect(scriptContent).toContain('NO_DELTA');
    expect(scriptContent).toContain('BASE_TREE');
    expect(scriptName).toBe('dispatch-deliver.sh');
  });
});

describe('delivery.ts — parseDeliveryOutput', () => {
  it('parses a bare DELIVERED line into a delivered outcome', () => {
    const result = parseDeliveryOutput('DELIVERED:abc123');
    expect(result.status).toBe('delivered');
    if (result.status !== 'delivered') return;
    expect(result.commitSha).toBe('abc123');
  });

  it('parses a fully marker-annotated DELIVERED output', () => {
    const stdout = [
      'DELIVERED:abc123',
      '---BRANCH-START---',
      'dispatch/HO-0002',
      '---BRANCH-END---',
      '---CHANGED-FILES-START---',
      'src/slugify.mjs',
      'test/slugify.test.mjs',
      '---CHANGED-FILES-END---',
    ].join('\n');

    const result = parseDeliveryOutput(stdout);
    expect(result.status).toBe('delivered');
    if (result.status !== 'delivered') return;
    expect(result.commitSha).toBe('abc123');
    expect(result.branch).toBe('dispatch/HO-0002');
    expect(result.changedFiles).toEqual(['src/slugify.mjs', 'test/slugify.test.mjs']);
  });

  it('parses IDEMPOTENT as a no_changes outcome (idempotent redelivery)', () => {
    const result = parseDeliveryOutput('IDEMPOTENT');
    expect(result.status).toBe('no_changes');
  });

  it('parses NO_DELTA as a no_delta outcome (worker produced no diff from base)', () => {
    const result = parseDeliveryOutput('NO_DELTA');
    expect(result.status).toBe('no_delta');
  });

  it('parses a CONFLICT line into a conflict outcome', () => {
    const result = parseDeliveryOutput('CONFLICT:def456');
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.existingTree).toBe('def456');
  });

  it('reports an error outcome for unrecognized output', () => {
    const result = parseDeliveryOutput('something unexpected');
    expect(result.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — WK-0180: named ignored writes under write_scope (guard 2)
// ---------------------------------------------------------------------------

describe('delivery.ts — buildDeliveryScript ignored-write detection (WK-0180)', () => {
  it('generates the post-add ignored-write scan when writeScope is given', () => {
    const { scriptContent } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
      writeScope: ['src/', 'test/exact.txt'],
    });

    expect(scriptContent).toContain("ls-files --others -i --exclude-standard -- 'src/' 'test/exact.txt'");
    expect(scriptContent).toContain('NO_DELTA_IGNORED');
    expect(scriptContent).toContain('IGNORED_SKIPPED');
  });

  it('omits the ignored-write scan when writeScope is not given (unaffected callers)', () => {
    const { scriptContent } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
    });

    expect(scriptContent).not.toContain('ls-files --others -i --exclude-standard --');
  });
});

describe('delivery.ts — parseDeliveryOutput ignored-write markers (WK-0180)', () => {
  it('returns ignoredFiles on a no_delta outcome when NO_DELTA_IGNORED is present', () => {
    const stdout = [
      'NO_DELTA_IGNORED',
      '---IGNORED-START---',
      'src/scratch/secret.txt',
      '---IGNORED-END---',
    ].join('\n');

    const result = parseDeliveryOutput(stdout);
    expect(result.status).toBe('no_delta');
    if (result.status !== 'no_delta') return;
    expect(result.ignoredFiles).toEqual(['src/scratch/secret.txt']);
  });

  it('returns ignoredFiles on a delivered outcome when IGNORED_SKIPPED is present', () => {
    const stdout = [
      'DELIVERED:abc123',
      '---BRANCH-START---',
      'dispatch/HO-0002',
      '---BRANCH-END---',
      '---CHANGED-FILES-START---',
      'src/slugify.mjs',
      '---CHANGED-FILES-END---',
      'IGNORED_SKIPPED',
      '---IGNORED-START---',
      'src/dist/build.js',
      '---IGNORED-END---',
    ].join('\n');

    const result = parseDeliveryOutput(stdout);
    expect(result.status).toBe('delivered');
    if (result.status !== 'delivered') return;
    expect(result.changedFiles).toEqual(['src/slugify.mjs']);
    expect(result.ignoredFiles).toEqual(['src/dist/build.js']);
  });

  it('leaves ignoredFiles undefined on a bare no_delta outcome with no ignored writes', () => {
    const result = parseDeliveryOutput('NO_DELTA');
    expect(result.status).toBe('no_delta');
    if (result.status !== 'no_delta') return;
    expect(result.ignoredFiles).toBeUndefined();
  });

  it('leaves ignoredFiles undefined on a delivered outcome with no ignored writes', () => {
    const result = parseDeliveryOutput('DELIVERED:abc123');
    expect(result.status).toBe('delivered');
    if (result.status !== 'delivered') return;
    expect(result.ignoredFiles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WK-0075 (historical): worker infra dir exclusion (.pi-agent/). Originally
// pipeline.ts filtered `.pi-agent/` out of enumeration/delivery because the
// S0 jail put the worker's config dir inside the writable clone. The S5 EROFS
// fix moved workerDir to /tmp/.pi-agent (inside the jail's own tmpfs, never
// under clonePath), so that filtering step no longer exists in pipeline.ts —
// `.pi-agent/` paths simply never appear in enumeration output any more. The
// tests below still hold as generic, adapter-agnostic coverage of
// delivery.ts's own primitives (parseEnumerateOutput does not special-case
// any path; buildDeliveryScript's excludePrefixes remains a supported,
// generic option for any future caller), just no longer wired to this
// specific scenario in pipeline.ts.
// ---------------------------------------------------------------------------

describe('parseEnumerateOutput does not filter any paths (adapter-agnostic; callers filter, not this module)', () => {
  it('includes .pi-agent/ files in untrackedFiles (a stand-in for any worker-infra-shaped path)', () => {
    const stdout = [
      '---STATUS-START---',
      ' M src/foo.ts',
      '---STATUS-END---',
      '---RENAME-START---',
      '---RENAME-END---',
      '---DIFF-START---',
      '---DIFF-END---',
      '---UNTRACKED-START---',
      '.pi-agent/auth.json',
      '.pi-agent/models.json',
      '.pi-agent/models-store.json',
      'src/new-file.ts',
      '---UNTRACKED-END---',
    ].join('\n');

    const result = parseEnumerateOutput(stdout);
    expect(result.untrackedFiles).toContain('.pi-agent/auth.json');
    expect(result.untrackedFiles).toContain('.pi-agent/models.json');
    expect(result.untrackedFiles).toContain('.pi-agent/models-store.json');
    expect(result.untrackedFiles).toContain('src/new-file.ts');
    expect(result.changedFiles).toContain('src/foo.ts');
  });
});

describe('buildDeliveryScript excludePrefixes — generic git-add exclusion (no longer wired to .pi-agent by pipeline.ts)', () => {
  it('generates pathspec excludes when excludePrefixes are given', () => {
    const { scriptContent } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
      excludePrefixes: ['.pi-agent'],
    });

    expect(scriptContent).toContain("add -A -- ':!.pi-agent'");
  });

  it('uses bare git add -A when no excludePrefixes are given', () => {
    const { scriptContent } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
    });

    expect(scriptContent).toMatch(/\$GIT add -A\n/);
  });

  it('handles multiple exclude prefixes', () => {
    const { scriptContent } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
      excludePrefixes: ['.pi-agent', '.codex'],
    });

    expect(scriptContent).toContain("':!.pi-agent'");
    expect(scriptContent).toContain("':!.codex'");
    expect(scriptContent).toContain('add -A --');
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — WK-0169: untouched 0-byte write_scope skeleton filtering
//
// A live-execution test (real git, real bash) rather than a stdout-shape
// assertion: this is exactly the mechanism the bug report needed proven —
// that the generated script itself, not just its text, excludes an
// untouched skeleton blob from the landed tree/diff.
// ---------------------------------------------------------------------------

describe('delivery.ts — buildDeliveryScript filters untouched 0-byte write_scope skeletons (WK-0169, narrowed by WK-0263)', () => {
  it('generates the empty-blob exclusion fragment, gated on the step-9b-created skeleton path list', () => {
    const { scriptContent } = buildDeliveryScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/mnt/c/example/projects/kb',
      handoffId: 'HO-0002',
      baseSha: 'deadbeef',
      skeletonPaths: ['src/skeleton.txt'],
    });

    expect(scriptContent).toContain('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(scriptContent).toContain('update-index --force-remove');
    expect(scriptContent).toContain("SKELETON_PATHS=('src/skeleton.txt')");
    expect(scriptContent).toContain('is_skeleton_path');
  });

  it('excludes an untouched skeleton but includes a worker-written file in a real delivery', async () => {
    const motherRepo = await createTempDir('kb-wk0169-mother-');
    const cloneRepo = await createTempDir('kb-wk0169-clone-');
    // Deliberately outside cloneRepo — the delivery script must not land itself.
    const scriptDir = await createTempDir('kb-wk0169-script-');
    try {
      execFileSync('git', ['init'], { cwd: motherRepo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: motherRepo });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: motherRepo });
      await writeFile(join(motherRepo, 'README.md'), 'fixture repo\n', 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: motherRepo });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: motherRepo });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: motherRepo }).toString().trim();

      // Simulate the ephemeral clone: a plain checkout of the mother repo at baseSha.
      await rm(cloneRepo, { recursive: true, force: true });
      execFileSync('git', ['clone', motherRepo, cloneRepo]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: cloneRepo });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: cloneRepo });

      // Step 9b skeleton pre-creation: two write_scope entries touched into
      // existence as 0-byte files (O_CREAT|O_EXCL, chassis pattern).
      await mkdir(join(cloneRepo, 'src'), { recursive: true });
      await (await open(join(cloneRepo, 'src', 'skeleton-untouched.txt'), 'wx')).close();
      await (await open(join(cloneRepo, 'src', 'skeleton-active.ts'), 'wx')).close();

      // The worker writes to only one of the two skeleton files.
      await writeFile(join(cloneRepo, 'src', 'skeleton-active.ts'), 'export const x = 1;\n', 'utf8');

      const { scriptContent } = buildDeliveryScript({
        clonePath: cloneRepo,
        motherRepoWsl: motherRepo,
        handoffId: 'HO-WK0169',
        baseSha,
        // Mirrors step 9b's return value: both file-level skeletons were
        // created fresh in this (simulated) run.
        skeletonPaths: ['src/skeleton-untouched.txt', 'src/skeleton-active.ts'],
      });
      const scriptPath = join(scriptDir, 'dispatch-deliver.sh');
      await writeFile(scriptPath, scriptContent, 'utf8');
      const stdout = execFileSync('bash', [scriptPath]).toString();

      const delivery = parseDeliveryOutput(stdout);
      expect(delivery.status).toBe('delivered');
      if (delivery.status !== 'delivered') return;
      expect(delivery.changedFiles).toEqual(['src/skeleton-active.ts']);
      expect(delivery.changedFiles).not.toContain('src/skeleton-untouched.txt');

      // Cross-check against the actual landed commit in the mother repo.
      const showTree = execFileSync(
        'git',
        ['show', '--stat', '--format=', `refs/heads/dispatch/HO-WK0169`],
        { cwd: motherRepo },
      ).toString();
      expect(showTree).toContain('src/skeleton-active.ts');
      expect(showTree).not.toContain('src/skeleton-untouched.txt');
    } finally {
      await rm(motherRepo, { recursive: true, force: true });
      await rm(cloneRepo, { recursive: true, force: true });
      await rm(scriptDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — WK-0263: the skeleton filter keys on "created by step 9b in
// this run", not "empty and new" (WK-0169's original, too-broad rule).
// ---------------------------------------------------------------------------

/** Shared real-git fixture setup for the WK-0263 live-execution tests below. */
async function setupMotherAndClone(): Promise<{
  motherRepo: string;
  cloneRepo: string;
  scriptDir: string;
  baseSha: string;
}> {
  const motherRepo = await createTempDir('kb-wk0263-mother-');
  const cloneRepo = await createTempDir('kb-wk0263-clone-');
  const scriptDir = await createTempDir('kb-wk0263-script-');

  execFileSync('git', ['init'], { cwd: motherRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: motherRepo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: motherRepo });
  await writeFile(join(motherRepo, 'README.md'), 'fixture repo\n', 'utf8');
  await writeFile(join(motherRepo, 'tracked-not-empty.txt'), 'pre-existing content\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: motherRepo });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: motherRepo });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: motherRepo }).toString().trim();

  await rm(cloneRepo, { recursive: true, force: true });
  execFileSync('git', ['clone', motherRepo, cloneRepo]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: cloneRepo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: cloneRepo });

  return { motherRepo, cloneRepo, scriptDir, baseSha };
}

describe('delivery.ts — buildDeliveryScript keeps worker-created zero-byte files (WK-0263)', () => {
  it('AC1: keeps a worker-created zero-byte file under a directory write_scope entry', async () => {
    const { motherRepo, cloneRepo, scriptDir, baseSha } = await setupMotherAndClone();
    try {
      // `skills/ntfy-bridge/` is a directory write_scope entry: step 9b only
      // mkdirs it (precreateWriteScopeSkeleton never creates a file skeleton
      // for a directory entry), so this path never reaches skeletonPaths.
      await mkdir(join(cloneRepo, 'skills', 'ntfy-bridge'), { recursive: true });
      await writeFile(join(cloneRepo, 'skills', 'ntfy-bridge', 'poll-zero.jsonl'), '', 'utf8');

      const { scriptContent } = buildDeliveryScript({
        clonePath: cloneRepo,
        motherRepoWsl: motherRepo,
        handoffId: 'HO-WK0263-AC1',
        baseSha,
        skeletonPaths: [],
      });
      const scriptPath = join(scriptDir, 'dispatch-deliver.sh');
      await writeFile(scriptPath, scriptContent, 'utf8');
      const stdout = execFileSync('bash', [scriptPath]).toString();

      const delivery = parseDeliveryOutput(stdout);
      expect(delivery.status).toBe('delivered');
      if (delivery.status !== 'delivered') return;
      expect(delivery.changedFiles).toContain('skills/ntfy-bridge/poll-zero.jsonl');

      const showTree = execFileSync(
        'git',
        ['show', '--stat', '--format=', 'refs/heads/dispatch/HO-WK0263-AC1'],
        { cwd: motherRepo },
      ).toString();
      expect(showTree).toContain('skills/ntfy-bridge/poll-zero.jsonl');

      const blob = execFileSync(
        'git',
        ['show', 'refs/heads/dispatch/HO-WK0263-AC1:skills/ntfy-bridge/poll-zero.jsonl'],
        { cwd: motherRepo },
      ).toString();
      expect(blob).toBe('');
    } finally {
      await rm(motherRepo, { recursive: true, force: true });
      await rm(cloneRepo, { recursive: true, force: true });
      await rm(scriptDir, { recursive: true, force: true });
    }
  });

  it('AC3: keeps a pre-existing tracked file the worker truncated to empty', async () => {
    const { motherRepo, cloneRepo, scriptDir, baseSha } = await setupMotherAndClone();
    try {
      // tracked-not-empty.txt already exists at baseSha with non-empty
      // content; step 9b never touches it (not a write_scope entry at all),
      // so it is never a skeleton candidate. The worker truncates it directly.
      await writeFile(join(cloneRepo, 'tracked-not-empty.txt'), '', 'utf8');

      const { scriptContent } = buildDeliveryScript({
        clonePath: cloneRepo,
        motherRepoWsl: motherRepo,
        handoffId: 'HO-WK0263-AC3',
        baseSha,
        skeletonPaths: [],
      });
      const scriptPath = join(scriptDir, 'dispatch-deliver.sh');
      await writeFile(scriptPath, scriptContent, 'utf8');
      const stdout = execFileSync('bash', [scriptPath]).toString();

      const delivery = parseDeliveryOutput(stdout);
      expect(delivery.status).toBe('delivered');
      if (delivery.status !== 'delivered') return;
      expect(delivery.changedFiles).toContain('tracked-not-empty.txt');

      const showTree = execFileSync(
        'git',
        ['show', '--stat', '--format=', 'refs/heads/dispatch/HO-WK0263-AC3'],
        { cwd: motherRepo },
      ).toString();
      expect(showTree).toContain('tracked-not-empty.txt');
    } finally {
      await rm(motherRepo, { recursive: true, force: true });
      await rm(cloneRepo, { recursive: true, force: true });
      await rm(scriptDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// capture.ts — writeResponseDoc
// ---------------------------------------------------------------------------

describe('capture.ts — writeResponseDoc', () => {
  let runDir: string | undefined;

  afterEach(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  it('generates the correct markdown structure for a delivered outcome', async () => {
    runDir = await createTempDir('kb-capture-');
    const delivery: DeliveryOutcome = {
      status: 'delivered',
      branch: 'dispatch/HO-0002',
      commitSha: 'abc123',
      changedFiles: ['src/slugify.mjs', 'test/slugify.test.mjs'],
    };

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0002', title: 'Add a slugify utility with node:test coverage', mode: 'implement' },
      delivery,
      piResult: { outcome: 'completed', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: 125, costUsd: 0.0012 } },
      model: 'deepseek/deepseek-v4-flash-0731',
      isolationBackend: 'bwrap-wsl2',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.responsePath).toBe(join(runDir, 'HO-0002.response.md'));

    const { responseContent } = result.data;
    expect(responseContent).toContain('handoff_id: HO-0002');
    expect(responseContent).toContain('outcome: delivered');
    expect(responseContent).toContain('model: deepseek/deepseek-v4-flash-0731');
    expect(responseContent).toContain('isolation_backend: bwrap-wsl2');
    expect(responseContent).toContain('total_tokens: 125');
    expect(responseContent).toContain('cost_usd: 0.0012');
    expect(responseContent).toContain('branch: dispatch/HO-0002');
    expect(responseContent).toContain('changed_files: ["src/slugify.mjs", "test/slugify.test.mjs"]');
    expect(responseContent).toContain('# Response: Add a slugify utility with node:test coverage');
    expect(responseContent).toContain('## Outcome');
    expect(responseContent).toContain('Delivered to `dispatch/HO-0002` at commit `abc123`.');
    expect(responseContent).toContain('## Changed Files');
    expect(responseContent).toContain('- src/slugify.mjs');
    expect(responseContent).toContain('## Usage');
    expect(responseContent).toContain('- Tokens: 125');
    expect(responseContent).toContain('- Cost: $0.0012');

    const onDisk = await readFile(result.data.responsePath, 'utf8');
    expect(onDisk).toBe(responseContent);
  });

  it('notes the refusal and quarantine path for a refused_out_of_scope delivery', async () => {
    runDir = await createTempDir('kb-capture-refuse-');
    const delivery: DeliveryOutcome = {
      status: 'refused_out_of_scope',
      offendingPaths: ['lib/evil.ts'],
      quarantinePath: join(runDir, 'quarantine.diff'),
    };

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0009', title: 'Out of scope test', mode: 'implement' },
      delivery,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.responseContent).toContain('outcome: refused');
    expect(result.data.responseContent).toContain('lib/evil.ts');
    expect(result.data.responseContent).toContain('quarantine.diff');
    expect(result.data.responseContent).toContain('changed_files: []');
  });

  it('notes the refusal and quarantine path for a secret_in_diff delivery', async () => {
    runDir = await createTempDir('kb-capture-secret-');
    const delivery: DeliveryOutcome = {
      status: 'secret_in_diff',
      patterns: ['aws_access_key_id'],
      quarantinePath: join(runDir, 'quarantine.diff'),
    };

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0010', title: 'Secret leak test', mode: 'implement' },
      delivery,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.responseContent).toContain('outcome: refused');
    expect(result.data.responseContent).toContain('aws_access_key_id');
    expect(result.data.responseContent).toContain('quarantine.diff');
  });

  it('renders a ## Mount Writes section with file entries when mountWrites is provided (WK-0164)', async () => {
    runDir = await createTempDir('kb-capture-mountwrites-');

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0011', title: 'Mount write test', mode: 'implement' },
      delivery: { status: 'no_changes' },
      mountWrites: [
        { mountPath: '/data/output', files: ['result.csv', 'nested/log.txt'] },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.responseContent).toContain('## Mount Writes');
    expect(result.data.responseContent).toContain('/data/output');
    expect(result.data.responseContent).toContain('- result.csv');
    expect(result.data.responseContent).toContain('- nested/log.txt');
  });

  it('omits the ## Mount Writes section when mountWrites is empty or undefined', async () => {
    runDir = await createTempDir('kb-capture-nomountwrites-');

    const withoutField = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0012', title: 'No mount writes test', mode: 'implement' },
      delivery: { status: 'no_changes' },
    });
    expect(withoutField.ok).toBe(true);
    if (withoutField.ok) {
      expect(withoutField.data.responseContent).not.toContain('## Mount Writes');
    }

    const withEmptyArray = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0013', title: 'Empty mount writes test', mode: 'implement' },
      delivery: { status: 'no_changes' },
      mountWrites: [],
    });
    expect(withEmptyArray.ok).toBe(true);
    if (withEmptyArray.ok) {
      expect(withEmptyArray.data.responseContent).not.toContain('## Mount Writes');
    }
  });
});

// ---------------------------------------------------------------------------
// capture.ts — buildProvenanceWriteBack
// ---------------------------------------------------------------------------

describe('capture.ts — buildProvenanceWriteBack', () => {
  it('returns the correct write-back fields for a delivered run', () => {
    const delivery: DeliveryOutcome = {
      status: 'delivered',
      branch: 'dispatch/HO-0002',
      commitSha: 'abc123',
      changedFiles: ['src/slugify.mjs'],
    };

    const { fields } = buildProvenanceWriteBack({
      runDir: '/tmp/run/RUN-0001',
      handoff: { id: 'HO-0002', title: 'Add a slugify utility', mode: 'implement' },
      delivery,
      model: 'deepseek/deepseek-v4-flash-0731',
      family: 'pi',
      isolationBackend: 'bwrap-wsl2',
    });

    expect(fields.run_id).toBe('RUN-0001');
    expect(fields.agent).toBe('pi');
    expect(fields.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(fields.enforced).toBe(true);
    expect(fields.isolation_backend).toBe('bwrap-wsl2');
    expect(fields.branch).toBe('dispatch/HO-0002');
    expect(fields.response).toBe('HO-0002.response.md');
    expect(fields.credentials_granted).toEqual([]);
  });

  it('leaves branch empty when nothing was delivered', () => {
    const { fields } = buildProvenanceWriteBack({
      runDir: '/tmp/run/RUN-0002',
      handoff: { id: 'HO-0003', title: 'No-op run', mode: 'implement' },
      delivery: { status: 'no_changes' },
    });

    expect(fields.branch).toBe('');
    expect(fields.run_id).toBe('RUN-0002');
  });

  it('includes inference_provider in write-back fields when provided', () => {
    const { fields } = buildProvenanceWriteBack({
      runDir: '/tmp/run/RUN-0004',
      handoff: { id: 'HO-0005', title: 'Provider test', mode: 'implement' },
      delivery: { status: 'no_changes' },
      inferenceProvider: 'DeepInfra',
    });

    expect(fields.inference_provider).toBe('DeepInfra');
  });

  it('omits inference_provider from write-back fields when not provided', () => {
    const { fields } = buildProvenanceWriteBack({
      runDir: '/tmp/run/RUN-0005',
      handoff: { id: 'HO-0006', title: 'No provider test', mode: 'implement' },
      delivery: { status: 'no_changes' },
    });

    expect('inference_provider' in fields).toBe(false);
  });
});

describe('capture.ts — writeResponseDoc inference_provider', () => {
  let runDir: string;

  it('includes inference_provider in response doc frontmatter when provided', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'kb-capture-prov-'));
    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0007', title: 'Provenance test', mode: 'implement' },
      delivery: { status: 'no_changes' },
      inferenceProvider: 'DeepInfra',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.responseContent).toContain('inference_provider: DeepInfra');
    await rm(runDir, { recursive: true, force: true });
  });

  it('omits inference_provider from response doc when not provided', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'kb-capture-noprov-'));
    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0008', title: 'No provenance test', mode: 'implement' },
      delivery: { status: 'no_changes' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.responseContent).not.toContain('inference_provider');
    await rm(runDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — attribute source, stage -> check -> land.
//
// Every fixture below is a throwaway git repo under a temp dir, and every
// assertion reads a git object or a parser result — never a
// self-report. No destructive command is ever run (the repo standing rule).
// ---------------------------------------------------------------------------

interface GitFixture {
  motherRepo: string;
  cloneRepo: string;
  baseSha: string;
}

async function initGitRepo(dir: string): Promise<void> {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function gitOut(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

async function commitAll(dir: string, message: string): Promise<string> {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', message], { cwd: dir });
  return gitOut(dir, ['rev-parse', 'HEAD']).trim();
}

/** A mother repo at one commit plus a plain clone of it (the stage/land clone). */
async function makeGitFixture(setup?: (motherRepo: string) => Promise<void>): Promise<GitFixture> {
  const motherRepo = await createTempDir('kb-delivery-fixture-mother-');
  await initGitRepo(motherRepo);
  await writeFile(join(motherRepo, 'README.md'), 'fixture repo\n', 'utf8');
  if (setup) await setup(motherRepo);
  const baseSha = await commitAll(motherRepo, 'base');
  const cloneRepo = await createTempDir('kb-delivery-fixture-clone-');
  await rm(cloneRepo, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', motherRepo, cloneRepo]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: cloneRepo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: cloneRepo });
  return { motherRepo, cloneRepo, baseSha };
}

async function cleanGitFixture(fixture: GitFixture): Promise<void> {
  await rm(fixture.motherRepo, { recursive: true, force: true });
  await rm(fixture.cloneRepo, { recursive: true, force: true });
}

async function runStage(
  fixture: GitFixture,
  opts: {
    writeScope?: string[];
    skeletonPaths?: string[];
    valueScanLines?: string[];
    attrSha?: string;
  } = {},
): Promise<Awaited<ReturnType<typeof runStageScript>>> {
  return runStageScript({
    clonePath: fixture.cloneRepo,
    baseSha: fixture.baseSha,
    attrSha: opts.attrSha ?? fixture.baseSha,
    writeScope: opts.writeScope ?? [],
    skeletonPaths: opts.skeletonPaths,
    valueScanLines: opts.valueScanLines,
  });
}

/** Run the real stage script into a caller-owned stage dir, so listing files can be inspected. */
async function runStageRaw(
  fixture: GitFixture,
  opts: {
    writeScope?: string[];
    skeletonPaths?: string[];
    valueScanLines?: string[];
    attrSha?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ exitCode: number; stdout: string; stageDir: string; cleanup: () => Promise<void> }> {
  const stageDir = await createTempDir(STAGE_TEMP_PREFIX);
  const script = buildStageScript({
    clonePath: fixture.cloneRepo,
    baseSha: fixture.baseSha,
    attrSha: opts.attrSha ?? fixture.baseSha,
    stageDir,
    writeScope: opts.writeScope ?? [],
    skeletonPaths: opts.skeletonPaths,
    valueScanLines: opts.valueScanLines,
  });
  const res = await execBash({ scriptContent: script.scriptContent, timeoutMs: 120_000, env: opts.env });
  if (!res.ok) throw new Error(res.message);
  return {
    exitCode: res.data.exitCode,
    stdout: res.data.stdout,
    stageDir,
    cleanup: () => rm(stageDir, { recursive: true, force: true }),
  };
}

const ZERO_SHA = '0'.repeat(40);

/** One `diff-tree --raw -z` record (`:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`). */
function rawRecord(oldMode: string, newMode: string, status: string, path: string): Buffer {
  return Buffer.concat([
    Buffer.from(`:${oldMode} ${newMode} ${ZERO_SHA} ${ZERO_SHA} ${status}`),
    Buffer.from([0]),
    Buffer.from(path, 'utf8'),
    Buffer.from([0]),
  ]);
}

function nulList(paths: string[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [Buffer.from(path, 'utf8'), Buffer.from([0])]));
}

function fakeStage(overrides: Partial<StageResult> = {}): StageResult {
  return {
    tree: 'a'.repeat(40),
    noDelta: false,
    changedFiles: [],
    gitlinkPaths: [],
    ignoredFiles: [],
    secretHits: [],
    ...overrides,
  };
}

describe('delivery.ts — checkWriteScope compares changed paths exactly', () => {
  it('refuses a tracked file literally named `src\\x` under a `src/` scope', () => {
    const result = checkWriteScope(['src\\x'], ['src/']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.offendingPaths).toEqual(['src\\x']);
  });

  it('still normalizes a scope ENTRY declared with a backslash', () => {
    const result = checkWriteScope(['src/x.ts'], ['src\\']);
    expect(result.ok).toBe(true);
  });

  it('does not let `src\\x` masquerade as `src/x`', () => {
    expect(checkWriteScope(['src\\x'], ['src/']).ok).toBe(false);
    expect(checkWriteScope(['src/x'], ['src/']).ok).toBe(true);
  });
});

describe('delivery.ts — classifyStage owns the one check order', () => {
  it('returns no_delta first, before any gitlink or scope path is considered', () => {
    const stage = fakeStage({ noDelta: true, gitlinkPaths: ['sub'], changedFiles: ['lib/x.ts'] });
    expect(classifyStage(stage, ['src/'])).toEqual({ kind: 'no_delta' });
  });

  it('returns gitlink before the write-scope check, naming every gitlink path', () => {
    const stage = fakeStage({ gitlinkPaths: ['sub', 'src/embed'], changedFiles: ['src/ok.ts'] });
    expect(classifyStage(stage, ['src/', 'sub/'])).toEqual({ kind: 'gitlink', offendingPaths: ['sub', 'src/embed'] });
  });

  it('returns out_of_scope for a non-gitlink path outside write_scope', () => {
    const stage = fakeStage({ changedFiles: ['src/ok.ts', 'lib/bad.ts'] });
    expect(classifyStage(stage, ['src/'])).toEqual({ kind: 'out_of_scope', offendingPaths: ['lib/bad.ts'] });
  });

  it('returns secret_in_diff only after every path is in scope', () => {
    const stage = fakeStage({ changedFiles: ['src/ok.ts'], secretHits: ['API_TOKEN'] });
    expect(classifyStage(stage, ['src/'])).toEqual({ kind: 'secret_in_diff', patterns: ['API_TOKEN'] });
  });

  it('returns clean for an in-scope, secret-free, non-gitlink delta', () => {
    expect(classifyStage(fakeStage({ changedFiles: ['src/ok.ts'] }), ['src/'])).toEqual({ kind: 'clean' });
  });
});

describe('delivery.ts — parseStageOutput strict grammar', () => {
  const tree = 'f'.repeat(40);

  async function parseWith(raw: Buffer, ignored: Buffer, stdout: string) {
    const stageDir = await createTempDir(STAGE_TEMP_PREFIX);
    await writeFile(join(stageDir, STAGE_RAW_LISTING_FILENAME), raw);
    await writeFile(join(stageDir, STAGE_IGNORED_FILENAME), ignored);
    try {
      return await parseStageOutput(
        stdout,
        join(stageDir, STAGE_RAW_LISTING_FILENAME),
        join(stageDir, STAGE_IGNORED_FILENAME),
      );
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  }

  it('parses TREE plus the NUL-delimited raw and ignored listings', async () => {
    const result = await parseWith(
      rawRecord('100644', '100644', 'M', 'src/a.ts'),
      nulList(['src/scratch.txt']),
      `TREE ${tree}\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stage.tree).toBe(tree);
    expect(result.stage.noDelta).toBe(false);
    expect(result.stage.changedFiles).toEqual(['src/a.ts']);
    expect(result.stage.gitlinkPaths).toEqual([]);
    expect(result.stage.ignoredFiles).toEqual(['src/scratch.txt']);
  });

  it('records NO_DELTA and both gitlink modes', async () => {
    const result = await parseWith(
      Buffer.concat([
        rawRecord('160000', '160000', 'M', 'sub'),
        rawRecord('100644', '160000', 'T', 'src/linked'),
      ]),
      Buffer.alloc(0),
      `TREE ${tree}\nNO_DELTA\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stage.noDelta).toBe(true);
    expect(result.stage.gitlinkPaths).toEqual(['sub', 'src/linked']);
  });

  it('accepts SECRET_HIT names and rejects an invalid variable name', async () => {
    const good = await parseWith(Buffer.alloc(0), Buffer.alloc(0), `TREE ${tree}\nSECRET_HIT=API_TOKEN\n`);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.stage.secretHits).toEqual(['API_TOKEN']);

    const bad = await parseWith(Buffer.alloc(0), Buffer.alloc(0), `TREE ${tree}\nSECRET_HIT=1BAD\n`);
    expect(bad.ok).toBe(false);
  });

  it('rejects a missing or duplicated TREE line', async () => {
    expect((await parseWith(Buffer.alloc(0), Buffer.alloc(0), 'NO_DELTA\n')).ok).toBe(false);
    expect((await parseWith(Buffer.alloc(0), Buffer.alloc(0), `TREE ${tree}\nTREE ${tree}\n`)).ok).toBe(false);
  });

  it('rejects any line outside the grammar', async () => {
    expect((await parseWith(Buffer.alloc(0), Buffer.alloc(0), `TREE ${tree}\nhello\n`)).ok).toBe(false);
    expect((await parseWith(Buffer.alloc(0), Buffer.alloc(0), `TREE ${tree}\nNO_DELTA\nNO_DELTA\n`)).ok).toBe(false);
  });

  it('rejects a missing listing file', async () => {
    const stageDir = await createTempDir(STAGE_TEMP_PREFIX);
    try {
      await writeFile(join(stageDir, STAGE_IGNORED_FILENAME), Buffer.alloc(0));
      const result = await parseStageOutput(
        `TREE ${tree}\n`,
        join(stageDir, STAGE_RAW_LISTING_FILENAME),
        join(stageDir, STAGE_IGNORED_FILENAME),
      );
      expect(result.ok).toBe(false);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });

  it('rejects a truncated (not NUL-terminated) listing', async () => {
    const result = await parseWith(Buffer.from('not terminated'), Buffer.alloc(0), `TREE ${tree}\n`);
    expect(result.ok).toBe(false);
  });

  it('rejects an incomplete record (odd NUL-part count) and a malformed header', async () => {
    const incomplete = await parseWith(Buffer.from(':100644 100644 0 0 M\u0000src/a.ts'), Buffer.alloc(0), `TREE ${tree}\n`);
    expect(incomplete.ok).toBe(false);
    const malformed = await parseWith(rawRecord('100644', '100644', 'M', 'src/a.ts').subarray(1), Buffer.alloc(0), `TREE ${tree}\n`);
    // subarray(1) still has a valid trailing NUL pair? It starts mid-header, so the header fails the regex.
    expect(malformed.ok).toBe(false);
  });

  it('rejects a path that is not valid UTF-8', async () => {
    const badPath = Buffer.from([0xff, 0xfe]);
    const raw = Buffer.concat([
      Buffer.from(`:100644 100644 ${ZERO_SHA} ${ZERO_SHA} M`),
      Buffer.from([0]),
      badPath,
      Buffer.from([0]),
    ]);
    const result = await parseWith(raw, Buffer.alloc(0), `TREE ${tree}\n`);
    expect(result.ok).toBe(false);
  });

  it('rejects an over-cap listing before reading it (sparse file)', async () => {
    const stageDir = await createTempDir(STAGE_TEMP_PREFIX);
    try {
      const handle = await open(join(stageDir, STAGE_RAW_LISTING_FILENAME), 'w');
      await handle.truncate(MAX_BUFFER_BYTES + 1);
      await handle.close();
      await writeFile(join(stageDir, STAGE_IGNORED_FILENAME), Buffer.alloc(0));
      const result = await parseStageOutput(
        `TREE ${tree}\n`,
        join(stageDir, STAGE_RAW_LISTING_FILENAME),
        join(stageDir, STAGE_IGNORED_FILENAME),
      );
      expect(result.ok).toBe(false);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });
});

describe('delivery.ts — parseLandOutput one-line grammar', () => {
  it('parses DELIVERED, IDEMPOTENT, and CONFLICT', () => {
    const sha = 'a'.repeat(40);
    expect(parseLandOutput(`DELIVERED:${sha}\n`)).toEqual({ ok: true, outcome: { status: 'delivered', commitSha: sha } });
    expect(parseLandOutput('IDEMPOTENT\n')).toEqual({ ok: true, outcome: { status: 'idempotent' } });
    expect(parseLandOutput(`CONFLICT:${sha}\n`)).toEqual({ ok: true, outcome: { status: 'conflict', existingTree: sha } });
  });

  it('rejects an extra line, an unknown token, or a malformed sha', () => {
    expect(parseLandOutput(`DELIVERED:${'a'.repeat(40)}\nIDEMPOTENT\n`).ok).toBe(false);
    expect(parseLandOutput('DONE\n').ok).toBe(false);
    expect(parseLandOutput('DELIVERED:zzzz\n').ok).toBe(false);
    expect(parseLandOutput('').ok).toBe(false);
  });
});

describe('delivery.ts — exported shared constants', () => {
  it('re-exports the one MAX_BUFFER_BYTES ceiling and the one ENV_NAME pattern', () => {
    expect(MAX_BUFFER_BYTES).toBe(64 * 1024 * 1024);
    expect(ENV_NAME.test('API_TOKEN')).toBe(true);
    expect(ENV_NAME.test('1BAD')).toBe(false);
    expect(STAGE_TEMP_PREFIX).toBe('kb-stage-');
  });
});

describe('delivery.ts — stage reads attributes from ATTR_SHA', () => {
  it('never lets a worker .gitattributes select a host filter, and keeps the raw staged bytes', async () => {
    const fixture = await makeGitFixture();
    const markerDir = await createTempDir('kb-delivery-fixture-marker-');
    const marker = join(markerDir, 'filter-ran');
    try {
      await writeFile(join(fixture.cloneRepo, '.gitattributes'), '* filter=evil\n', 'utf8');
      await writeFile(join(fixture.cloneRepo, 'payload.txt'), 'raw-bytes-must-survive\n', 'utf8');
      const env = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'filter.evil.clean',
        GIT_CONFIG_VALUE_0: `touch '${marker}'`,
      };

      // Control (rule 28: prove the check bites): without --attr-source the
      // worktree `.gitattributes` selects the host-defined driver, so the
      // clean command runs. The untrusted repo config makes the driver real.
      const control = await execBash({
        scriptContent: `set -euo pipefail
cd '${fixture.cloneRepo}'
IDX=$(mktemp)
export GIT_INDEX_FILE="$IDX"
git read-tree '${fixture.baseSha}'
git add -A
rm -f "$IDX"
`,
        timeoutMs: 120_000,
        env,
      });
      expect(control.ok).toBe(true);
      expect((await stat(marker)).isFile()).toBe(true);

      await rm(marker, { force: true });
      const raw = await runStageRaw(fixture, { env });
      try {
        expect(raw.exitCode).toBe(0);
        const parsed = await parseStageOutput(
          raw.stdout,
          join(raw.stageDir, STAGE_RAW_LISTING_FILENAME),
          join(raw.stageDir, STAGE_IGNORED_FILENAME),
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(await stat(marker).then(() => true, () => false)).toBe(false);
        const blob = execFileSync('git', ['cat-file', '-p', `${parsed.stage.tree}:payload.txt`], { cwd: fixture.cloneRepo });
        expect(blob.toString()).toBe('raw-bytes-must-survive\n');
      } finally {
        await raw.cleanup();
      }
    } finally {
      await cleanGitFixture(fixture);
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('pins attributes to mother HEAD, not a chained base_ref that carries a filter', async () => {
    const fixture = await makeGitFixture();
    const markerDir = await createTempDir('kb-delivery-fixture-chain-marker-');
    const marker = join(markerDir, 'filter-ran');
    const cloneRepo = await createTempDir('kb-delivery-fixture-chain-clone-');
    await rm(cloneRepo, { recursive: true, force: true });
    try {
      // A `dispatch/` branch carries a worker-written filter; mother HEAD does not.
      execFileSync('git', ['checkout', '-q', '-b', 'dispatch/HO-CHAIN', fixture.baseSha], { cwd: fixture.motherRepo });
      await writeFile(join(fixture.motherRepo, '.gitattributes'), '* filter=evil\n', 'utf8');
      const branchSha = await commitAll(fixture.motherRepo, 'chained base carries filter');
      execFileSync('git', ['checkout', '-q', '--detach', fixture.baseSha], { cwd: fixture.motherRepo });
      const motherHead = gitOut(fixture.motherRepo, ['rev-parse', 'HEAD']).trim();
      expect(motherHead).toBe(fixture.baseSha);
      expect(branchSha).not.toBe(motherHead);

      // The chained clone checks out base_ref, so the filter is in the worktree.
      execFileSync('git', ['clone', '-q', fixture.motherRepo, cloneRepo]);
      execFileSync('git', ['checkout', '-q', branchSha], { cwd: cloneRepo });
      await writeFile(join(cloneRepo, 'payload.txt'), 'raw-bytes-must-survive\n', 'utf8');

      const env = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'filter.evil.clean',
        GIT_CONFIG_VALUE_0: `touch '${marker}'`,
      };
      const chained: GitFixture = { motherRepo: fixture.motherRepo, cloneRepo, baseSha: branchSha };

      // Control: `--attr-source=<BASE_SHA>` (the branch) selects the filter.
      const control = await execBash({
        scriptContent: `set -euo pipefail
cd '${cloneRepo}'
IDX=$(mktemp)
export GIT_INDEX_FILE="$IDX"
git read-tree '${branchSha}'
git --attr-source=${branchSha} add -A
rm -f "$IDX"
`,
        timeoutMs: 120_000,
        env,
      });
      expect(control.ok).toBe(true);
      expect((await stat(marker)).isFile()).toBe(true);
      await rm(marker, { force: true });

      // Real: ATTR_SHA is mother HEAD, so the branch's filter is inert.
      const raw = await runStageRaw(chained, { attrSha: motherHead, env });
      try {
        expect(raw.exitCode).toBe(0);
        const parsed = await parseStageOutput(
          raw.stdout,
          join(raw.stageDir, STAGE_RAW_LISTING_FILENAME),
          join(raw.stageDir, STAGE_IGNORED_FILENAME),
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(await stat(marker).then(() => true, () => false)).toBe(false);
        const blob = execFileSync('git', ['cat-file', '-p', `${parsed.stage.tree}:payload.txt`], { cwd: cloneRepo });
        expect(blob.toString()).toBe('raw-bytes-must-survive\n');
      } finally {
        await raw.cleanup();
      }
    } finally {
      await cleanGitFixture(fixture);
      await rm(cloneRepo, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('refuses a swapped gitlink inside an in-scope submodule, and runs no nested-repo config', async () => {
    const fixture = await makeGitFixture(async (motherRepo) => {
      await mkdir(join(motherRepo, 'sub'), { recursive: true });
      await initGitRepo(join(motherRepo, 'sub'));
      await writeFile(join(motherRepo, 'sub', 'f.txt'), 'sub content\n', 'utf8');
      await commitAll(join(motherRepo, 'sub'), 'sub base');
    });
    const markerDir = await createTempDir('kb-delivery-fixture-gitlink-marker-');
    const fsmonitorMarker = join(markerDir, 'fsmonitor-ran');
    const filterMarker = join(markerDir, 'filter-ran');
    try {
      const subDir = join(fixture.cloneRepo, 'sub');
      await initGitRepo(subDir);
      await writeFile(join(subDir, 'g.txt'), 'swapped\n', 'utf8');
      await commitAll(subDir, 'sub swap');
      // The hostile config is written AFTER the setup commit. Otherwise the
      // setup's own `git add` would run it and the test would measure itself.
      execFileSync('git', ['config', 'core.fsmonitor', `touch '${fsmonitorMarker}'`], { cwd: subDir });
      execFileSync('git', ['config', 'filter.evil.clean', `touch '${filterMarker}'`], { cwd: subDir });

      // Scope is `sub/`, so only the gitlink refusal can stop this tree.
      const run = await runStage(fixture, { writeScope: ['sub/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.gitlinkPaths).toContain('sub');
      expect(classifyStage(run.stage, ['sub/'])).toEqual({ kind: 'gitlink', offendingPaths: ['sub'] });
      expect(await stat(fsmonitorMarker).then(() => true, () => false)).toBe(false);
      expect(await stat(filterMarker).then(() => true, () => false)).toBe(false);
    } finally {
      await cleanGitFixture(fixture);
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('refuses a newly added in-scope embedded repo with a commit as a gitlink', async () => {
    const fixture = await makeGitFixture();
    try {
      const embedDir = join(fixture.cloneRepo, 'src', 'embed');
      await mkdir(embedDir, { recursive: true });
      await initGitRepo(embedDir);
      await writeFile(join(embedDir, 'x.txt'), 'embedded\n', 'utf8');
      await commitAll(embedDir, 'embed');

      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.gitlinkPaths).toContain('src/embed');
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'gitlink', offendingPaths: ['src/embed'] });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('fails closed (non-zero, nothing lands) on an embedded repo with no commit', async () => {
    const fixture = await makeGitFixture();
    try {
      await mkdir(join(fixture.cloneRepo, 'src', 'embed'), { recursive: true });
      await initGitRepo(join(fixture.cloneRepo, 'src', 'embed'));

      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(false);
      if (run.ok) return;
      expect(run.message).toContain('exited with code');
      // Nothing landed: the mother has no dispatch branch.
      expect(() => gitOut(fixture.motherRepo, ['rev-parse', '--verify', 'refs/heads/dispatch/HO-X'])).toThrow();
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('lists both ends of an in-scope rename, a deletion, an exec-bit change, and a symlink, all clean', async () => {
    const fixture = await makeGitFixture(async (motherRepo) => {
      await mkdir(join(motherRepo, 'src'), { recursive: true });
      await writeFile(join(motherRepo, 'src', 'keep.txt'), 'keep\n', 'utf8');
      await writeFile(join(motherRepo, 'src', 'gone.txt'), 'gone\n', 'utf8');
      await writeFile(join(motherRepo, 'src', 'exec.sh'), '#!/bin/sh\n', 'utf8');
      await writeFile(join(motherRepo, 'src', 'target.txt'), 'target\n', 'utf8');
    });
    try {
      await rename(join(fixture.cloneRepo, 'src', 'keep.txt'), join(fixture.cloneRepo, 'src', 'keep2.txt'));
      await rm(join(fixture.cloneRepo, 'src', 'gone.txt'));
      await chmod(join(fixture.cloneRepo, 'src', 'exec.sh'), 0o755);
      await symlink('target.txt', join(fixture.cloneRepo, 'src', 'link'));

      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      for (const path of ['src/keep.txt', 'src/keep2.txt', 'src/gone.txt', 'src/exec.sh', 'src/link']) {
        expect(run.stage.changedFiles).toContain(path);
      }
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'clean' });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('refuses a tracked file literally named `src\\x` under a `src/` scope (real git)', async () => {
    const fixture = await makeGitFixture();
    try {
      await writeFile(join(fixture.cloneRepo, 'src\\x'), 'backslash\n', 'utf8');
      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.changedFiles).toContain('src\\x');
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'out_of_scope', offendingPaths: ['src\\x'] });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('refuses a rename across the scope boundary, listing both ends and naming the outside one', async () => {
    const fixture = await makeGitFixture(async (motherRepo) => {
      await mkdir(join(motherRepo, 'outside'), { recursive: true });
      await writeFile(join(motherRepo, 'outside', 'moved.txt'), 'moved\n', 'utf8');
    });
    try {
      await mkdir(join(fixture.cloneRepo, 'src'), { recursive: true });
      await rename(join(fixture.cloneRepo, 'outside', 'moved.txt'), join(fixture.cloneRepo, 'src', 'moved.txt'));

      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.changedFiles).toContain('outside/moved.txt');
      expect(run.stage.changedFiles).toContain('src/moved.txt');
      expect(classifyStage(run.stage, ['src/'])).toEqual({
        kind: 'out_of_scope',
        offendingPaths: ['outside/moved.txt'],
      });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('lists a worker write blocked by .gitignore in scope and returns no_delta', async () => {
    const fixture = await makeGitFixture(async (motherRepo) => {
      await mkdir(join(motherRepo, 'src'), { recursive: true });
      await writeFile(join(motherRepo, '.gitignore'), 'src/scratch/\n', 'utf8');
    });
    try {
      await mkdir(join(fixture.cloneRepo, 'src', 'scratch'), { recursive: true });
      await writeFile(join(fixture.cloneRepo, 'src', 'scratch', 'x.txt'), 'ignored\n', 'utf8');

      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.ignoredFiles).toContain('src/scratch/x.txt');
      expect(run.stage.noDelta).toBe(true);
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'no_delta' });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('drops only the untouched step-9b skeletons and keeps a worker-written one', async () => {
    const fixture = await makeGitFixture();
    try {
      await mkdir(join(fixture.cloneRepo, 'src'), { recursive: true });
      await (await open(join(fixture.cloneRepo, 'src', 'skeleton.txt'), 'wx')).close();
      await (await open(join(fixture.cloneRepo, 'src', 'active.txt'), 'wx')).close();
      await writeFile(join(fixture.cloneRepo, 'src', 'active.txt'), 'written\n', 'utf8');

      const run = await runStage(fixture, {
        writeScope: ['src/'],
        skeletonPaths: ['src/skeleton.txt', 'src/active.txt'],
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.changedFiles).toEqual(['src/active.txt']);
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'clean' });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('returns no_delta for a stage with no worktree change', async () => {
    const fixture = await makeGitFixture();
    try {
      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.noDelta).toBe(true);
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'no_delta' });
    } finally {
      await cleanGitFixture(fixture);
    }
  });

  it('emits TREE before it fails on an unwritable raw listing, and runStageScript maps the non-zero exit', async () => {
    const fixture = await makeGitFixture();
    const stageDir = await createTempDir(STAGE_TEMP_PREFIX);
    try {
      await mkdir(join(stageDir, STAGE_RAW_LISTING_FILENAME), { recursive: true });
      const script = buildStageScript({
        clonePath: fixture.cloneRepo,
        baseSha: fixture.baseSha,
        attrSha: fixture.baseSha,
        stageDir,
        writeScope: [],
      });
      const res = await execBash({ scriptContent: script.scriptContent, timeoutMs: 120_000 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.exitCode).not.toBe(0);
      expect(res.data.stdout).toContain('TREE ');

      const run = await runStage(fixture, { valueScanLines: ['false'] });
      expect(run.ok).toBe(false);
      if (run.ok) return;
      // The exit code is checked BEFORE any parse: a parse-shaped message
      // would mean the failed stage reached check. Nothing landed, so the
      // mother has no dispatch branch.
      expect(run.message).toContain('exited with code');
      expect(() => gitOut(fixture.motherRepo, ['rev-parse', '--verify', 'refs/heads/dispatch/HO-X'])).toThrow();
    } finally {
      await rm(stageDir, { recursive: true, force: true });
      await cleanGitFixture(fixture);
    }
  }, 120_000);
});

describe('delivery.ts — the value scan reads a --text diff', () => {
  it('flags an injected credential value hidden by a base `binary` attribute', async () => {
    const fixture = await makeGitFixture(async (motherRepo) => {
      await writeFile(join(motherRepo, '.gitattributes'), '*.bin binary\n', 'utf8');
    });
    const credDir = await createTempDir('kb-delivery-fixture-cred-');
    try {
      const value = 'EXAMPLE-NOT-A-REAL-SECRET-1234567890';
      const credFile = join(credDir, 'env');
      await writeFile(credFile, `API_TOKEN=${value}\n`, 'utf8');
      await mkdir(join(fixture.cloneRepo, 'src'), { recursive: true });
      await writeFile(join(fixture.cloneRepo, 'src', 'secret.bin'), `token=${value}\n`, 'utf8');

      const valueScanLines = buildInjectedValueScanFragment({
        granted: ['example-profile'],
        injections: [{ profileName: 'example-profile', varName: 'API_TOKEN', filePath: credFile }],
        backendApiKeyEnv: null,
        backendSecretsFile: null,
        credentialEndpoints: [],
      });

      const run = await runStage(fixture, { writeScope: ['src/'], valueScanLines });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.secretHits).toEqual(['API_TOKEN']);
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'secret_in_diff', patterns: ['API_TOKEN'] });
    } finally {
      await cleanGitFixture(fixture);
      await rm(credDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('flags a value in a file whose worktree `.gitattributes` marks it `-diff`', async () => {
    const fixture = await makeGitFixture();
    const credDir = await createTempDir('kb-delivery-fixture-cred-');
    try {
      const value = 'EXAMPLE-NOT-A-REAL-SECRET-0987654321';
      const credFile = join(credDir, 'env');
      await writeFile(credFile, `API_TOKEN=${value}\n`, 'utf8');
      await mkdir(join(fixture.cloneRepo, 'src'), { recursive: true });
      // A worktree attribute never reaches the pinned ATTR_SHA tree; `--text`
      // makes the diff carry the bytes even so.
      await writeFile(join(fixture.cloneRepo, 'src', '.gitattributes'), '*.bin -diff\n', 'utf8');
      await writeFile(join(fixture.cloneRepo, 'src', 'secret.bin'), `token=${value}\n`, 'utf8');

      const valueScanLines = buildInjectedValueScanFragment({
        granted: ['example-profile'],
        injections: [{ profileName: 'example-profile', varName: 'API_TOKEN', filePath: credFile }],
        backendApiKeyEnv: null,
        backendSecretsFile: null,
        credentialEndpoints: [],
      });

      const run = await runStage(fixture, { writeScope: ['src/'], valueScanLines });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.stage.secretHits).toEqual(['API_TOKEN']);
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'secret_in_diff', patterns: ['API_TOKEN'] });
    } finally {
      await cleanGitFixture(fixture);
      await rm(credDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('delivery.ts — stage -> check -> land over one tree', () => {
  it('lands the checked TREE with base_sha as parent, then is idempotent, then reports a conflict', async () => {
    const fixture = await makeGitFixture();
    const handoffId = 'HO-S2A-LAND';
    const ref = `refs/heads/dispatch/${handoffId}`;
    try {
      await mkdir(join(fixture.cloneRepo, 'src'), { recursive: true });
      await writeFile(join(fixture.cloneRepo, 'src', 'a.txt'), 'a\n', 'utf8');

      const run = await runStage(fixture, { writeScope: ['src/'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(classifyStage(run.stage, ['src/'])).toEqual({ kind: 'clean' });

      const landScript = buildLandScript({
        clonePath: fixture.cloneRepo,
        motherRepoWsl: fixture.motherRepo,
        handoffId,
        baseSha: fixture.baseSha,
        attrSha: fixture.baseSha,
        tree: run.stage.tree,
      });
      const first = await execBash({ scriptContent: landScript.scriptContent, timeoutMs: 120_000 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.exitCode).toBe(0);
      const landed = parseLandOutput(first.data.stdout);
      expect(landed.ok).toBe(true);
      if (!landed.ok || landed.outcome.status !== 'delivered') return;

      // The shipped tree is exactly the checked tree, on exactly base_sha.
      expect(gitOut(fixture.motherRepo, ['rev-parse', ref]).trim()).toBe(landed.outcome.commitSha);
      expect(gitOut(fixture.motherRepo, ['rev-parse', `${ref}^{tree}`]).trim()).toBe(run.stage.tree);
      expect(gitOut(fixture.motherRepo, ['rev-parse', `${ref}^`]).trim()).toBe(fixture.baseSha);

      // Redelivery of the same tree is idempotent, not a second commit.
      const second = await execBash({ scriptContent: landScript.scriptContent, timeoutMs: 120_000 });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(parseLandOutput(second.data.stdout)).toEqual({ ok: true, outcome: { status: 'idempotent' } });

      // A different tree from the same base is a structured conflict that
      // never clobbers the existing branch.
      await writeFile(join(fixture.cloneRepo, 'src', 'b.txt'), 'b\n', 'utf8');
      const run2 = await runStage(fixture, { writeScope: ['src/'] });
      expect(run2.ok).toBe(true);
      if (!run2.ok) return;
      const conflictScript = buildLandScript({
        clonePath: fixture.cloneRepo,
        motherRepoWsl: fixture.motherRepo,
        handoffId,
        baseSha: fixture.baseSha,
        attrSha: fixture.baseSha,
        tree: run2.stage.tree,
      });
      const third = await execBash({ scriptContent: conflictScript.scriptContent, timeoutMs: 120_000 });
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      expect(parseLandOutput(third.data.stdout)).toEqual({
        ok: true,
        outcome: { status: 'conflict', existingTree: run.stage.tree },
      });
      expect(gitOut(fixture.motherRepo, ['rev-parse', ref]).trim()).toBe(landed.outcome.commitSha);
    } finally {
      await cleanGitFixture(fixture);
    }
  }, 120_000);

  it('fails closed when the quarantine diff exceeds MAX_BUFFER_BYTES', async () => {
    const fixture = await makeGitFixture();
    try {
      await writeFile(join(fixture.cloneRepo, 'big.txt'), Buffer.alloc(MAX_BUFFER_BYTES + 1024 * 1024, 0x61));
      const run = await runStage(fixture, {});
      expect(run.ok).toBe(true);
      if (!run.ok) return;

      const script = buildQuarantineScript({
        clonePath: fixture.cloneRepo,
        baseSha: fixture.baseSha,
        attrSha: fixture.baseSha,
        tree: run.stage.tree,
      });
      const res = await execBash({ scriptContent: script.scriptContent, timeoutMs: 180_000 });
      // execBash loses stdout on an over-cap capture, so the pipeline's
      // writeQuarantineDiff maps this to DELIVERY_FAILED with no content named.
      expect(res.ok).toBe(false);
    } finally {
      await cleanGitFixture(fixture);
    }
  }, 180_000);
});

describe('delivery.ts — stage/land/quarantine script text', () => {
  const sha = 'a'.repeat(40);
  const attr = 'b'.repeat(40);

  it('runs every stage git call with --attr-source and the frozen -c values under set -euo pipefail', () => {
    const { scriptContent, scriptName } = buildStageScript({
      clonePath: '/tmp/run/clone',
      baseSha: sha,
      attrSha: attr,
      stageDir: '/tmp/run/stage',
      writeScope: ['src/'],
    });
    expect(scriptName).toBe('dispatch-stage.sh');
    // The attribute pin and the frozen config live in one quoted bash array,
    // so an untrusted sha can never be word-split or expanded.
    expect(scriptContent).toContain(`'--attr-source=${attr}'`);
    expect(scriptContent).toContain(
      "'-c' 'core.autocrlf=false' '-c' 'core.eol=lf' '-c' 'core.hooksPath=' '-c' 'core.fsmonitor='",
    );
    expect(scriptContent).toContain('set -euo pipefail');
    expect(scriptContent).not.toContain('|| true');
    expect(scriptContent).toContain('read-tree "$BASE_SHA"');
    expect(scriptContent).toContain('add -A');
    expect(scriptContent).toContain('write-tree');
    // TREE is printed before the raw listing redirect, so a failure after
    // TREE still leaves the check nothing to act on.
    expect(scriptContent.indexOf('echo "TREE $TREE"')).toBeLessThan(
      scriptContent.indexOf('> "$RAW_LISTING_FILE"'),
    );
    // The value-scan diff only exists when there is something to scan, and
    // it is always --text.
    expect(scriptContent).not.toContain('diff --text');
    const withScan = buildStageScript({
      clonePath: '/tmp/run/clone',
      baseSha: sha,
      attrSha: attr,
      stageDir: '/tmp/run/stage',
      writeScope: ['src/'],
      valueScanLines: ['echo hi'],
    });
    expect(withScan.scriptContent).toContain('diff --text --no-renames');
  });

  it('lands with commit-tree, the pinned identity, and a one-line CAS push', () => {
    const { scriptContent, scriptName } = buildLandScript({
      clonePath: '/tmp/run/clone',
      motherRepoWsl: '/tmp/run/mother',
      handoffId: 'HO-0002',
      baseSha: sha,
      attrSha: attr,
      tree: sha,
    });
    expect(scriptName).toBe('dispatch-land.sh');
    expect(scriptContent).toContain(`'--attr-source=${attr}'`);
    expect(scriptContent).toContain('commit-tree "$TREE" -p "$BASE_SHA"');
    expect(scriptContent).toContain('rev-parse --verify "refs/heads/dispatch/$HANDOFF_ID"');
    expect(scriptContent).toContain('push');
    expect(scriptContent).toContain('echo "DELIVERED:$COMMIT"');
    expect(scriptContent).toContain('echo "IDEMPOTENT"');
    expect(scriptContent).toContain('echo "CONFLICT:$EXISTING_TREE"');
    expect(scriptContent).toContain('GIT_COMMITTER_NAME="kb-dispatch"');
    expect(scriptContent).toContain('set -euo pipefail');
    expect(scriptContent).not.toContain('|| true');
  });

  it('quarantines with a tree-to-tree diff under the same attribute pin', () => {
    const { scriptContent, scriptName } = buildQuarantineScript({
      clonePath: '/tmp/run/clone',
      baseSha: sha,
      attrSha: attr,
      tree: sha,
    });
    expect(scriptName).toBe('dispatch-quarantine.sh');
    expect(scriptContent).toContain(`'--attr-source=${attr}'`);
    expect(scriptContent).toContain('diff --no-renames "$BASE_SHA" "$TREE"');
  });

  it('stages the ignored list with the unwidened write_scope pathspec only', () => {
    const { scriptContent } = buildStageScript({
      clonePath: '/tmp/run/clone',
      baseSha: sha,
      attrSha: attr,
      stageDir: '/tmp/run/stage',
      writeScope: ['src/', 'tests/one.ts'],
    });
    expect(scriptContent).toContain("ls-files -z --others -i --exclude-standard -- 'src/' 'tests/one.ts'");
  });
});
