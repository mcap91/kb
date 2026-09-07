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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  scanSecrets,
  buildDeliveryScript,
  parseDeliveryOutput,
  type DeliveryOutcome,
} from '../packages/dispatch-core/src/delivery.js';
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
    expect(scriptContent).toContain('GIT_INDEX_FILE="$CLONE_PATH/.dispatch-delivery-idx"');
    expect(scriptContent).toContain('read-tree "$BASE_SHA"');
    expect(scriptContent).toContain('write-tree');
    expect(scriptContent).toContain('commit-tree "$TREE" -p "$BASE_SHA"');
    expect(scriptContent).toContain('refs/heads/dispatch/$HANDOFF_ID');
    expect(scriptContent).toContain('IDEMPOTENT');
    expect(scriptContent).toContain('CONFLICT:');
    expect(scriptContent).toContain("HANDOFF_ID='HO-0002'");
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
// WK-0075: worker infra dir exclusion (.pi-agent/)
// ---------------------------------------------------------------------------

describe('WK-0075 — parseEnumerateOutput preserves .pi-agent/ files (pipeline owns filtering)', () => {
  it('includes .pi-agent/ files in untrackedFiles (proving pipeline filter is needed)', () => {
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

describe('WK-0075 — infra filtering before checkWriteScope', () => {
  const WORKER_INFRA_PREFIXES = ['.pi-agent'];
  const isWorkerInfra = (p: string): boolean =>
    WORKER_INFRA_PREFIXES.some(pfx => p === pfx || p.startsWith(pfx + '/'));

  it('without filter, .pi-agent/ files cause scope refusal', () => {
    const allFiles = ['src/foo.ts', '.pi-agent/auth.json', '.pi-agent/models.json'];
    const result = checkWriteScope(allFiles, ['src/']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.offendingPaths).toContain('.pi-agent/auth.json');
      expect(result.offendingPaths).toContain('.pi-agent/models.json');
    }
  });

  it('after filtering, scope check passes on task files alone', () => {
    const changedFiles = ['src/foo.ts'];
    const untrackedFiles = ['.pi-agent/auth.json', '.pi-agent/models.json', 'src/bar.ts'];

    const allFiltered = [
      ...changedFiles.filter(f => !isWorkerInfra(f)),
      ...untrackedFiles.filter(f => !isWorkerInfra(f)),
    ];
    expect(allFiltered).toEqual(['src/foo.ts', 'src/bar.ts']);

    const result = checkWriteScope(allFiltered, ['src/']);
    expect(result.ok).toBe(true);
  });

  it('filters the bare directory name as well as nested paths', () => {
    const files = ['.pi-agent', '.pi-agent/auth.json', 'src/ok.ts'];
    const filtered = files.filter(f => !isWorkerInfra(f));
    expect(filtered).toEqual(['src/ok.ts']);
  });
});

describe('WK-0075 — buildDeliveryScript excludes infra dirs from git-add', () => {
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
      piResult: { outcome: 'completed', usage: { totalTokens: 125, costUsd: 0.0012 } },
      model: 'deepseek/deepseek-v4-flash-0731',
      isolationBackend: 'bwrap-wsl2',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.responsePath).toBe(join(runDir, 'HO-0002.response.md'));

    const { responseContent } = result.data;
    expect(responseContent).toContain('handoff_id: HO-0002');
    expect(responseContent).toContain('outcome: completed');
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
});
