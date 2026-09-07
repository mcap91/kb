/**
 * PLN-0004 S0 Wave 3 — end-to-end fake-tier pipeline test.
 *
 * Chains the wave-1/wave-2 skeleton modules in the same order `pipeline.ts`'s
 * `runDispatch()` wires them, WITHOUT any real WSL2/bwrap/Pi (a "fake tier"):
 * parseHandoff -> checkAdmission -> resolveModel -> assemblePrompt ->
 * buildInvocation -> buildJailArgs -> buildEnumerateScript -> checkWriteScope
 * -> scanSecrets -> buildDeliveryScript -> parseDeliveryOutput ->
 * writeResponseDoc. The two points that would normally run inside WSL2
 * (enumerate + delivery) are simulated by hand-constructing the exact stdout
 * shape their scripts produce and feeding it through the real parsers — this
 * validates the ORCHESTRATION/wiring, not a live host. `runDispatch()` itself
 * is never called here (it needs a live WSL2/bwrap/Pi host); that live gate
 * is a separate, manually-run proof (execution/s0-rulings.md).
 *
 * No personal/absolute paths appear in fixtures (WK-0043 rule); all
 * filesystem tests use temp dirs. The seeded secret fixture uses AWS's own
 * documented example-only placeholder key, never a real-looking live key.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHandoff } from '../packages/dispatch-core/src/ho.js';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { getDefaultRegistry, resolveModel } from '../packages/dispatch-core/src/model-registry.js';
import { assemblePrompt } from '../packages/dispatch-core/src/assemble.js';
import { buildInvocation } from '../packages/dispatch-core/src/adapters/pi.js';
import { windowsToWslPath } from '../packages/dispatch-core/src/wsl2.js';
import { buildJailArgs } from '../packages/dispatch-core/src/jail.js';
import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  scanSecrets,
  buildDeliveryScript,
  parseDeliveryOutput,
  type DeliveryOutcome,
} from '../packages/dispatch-core/src/delivery.js';
import { writeResponseDoc } from '../packages/dispatch-core/src/capture.js';
import { parsePreflightOutput } from '../packages/dispatch-core/src/preflight.js';

// ---------------------------------------------------------------------------
// Fixture — a small, purpose-built HO-TEST.md (distinct from the frozen
// HO-0002/HO-0003 drafts reserved for the live test_kb gate proof).
// ---------------------------------------------------------------------------

const HO_TEST_CONTENT = `---
id: HO-TEST
title: Add a greet utility with node:test coverage
mode: implement
write_scope: ["src/", "test/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
acceptance:
  - "AC-1: greet('World') returns 'Hello, World!'"
  - "AC-2: \`node --test test/\` passes"
validation: ["node --test test/"]
status: draft
---

## Context
A minimal fixture repo for the dispatch v2 e2e fake-tier test.

## Task
1. Create \`src/greet.mjs\` exporting \`greet(name)\`, returning \`Hello, \${name}!\`.
2. Create \`test/greet.test.mjs\` covering AC-1.

## Constraints
- Touch only \`src/\` and \`test/\`.
`;

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Set up a fresh temp git repo with HO-TEST.md + README.md committed on main. */
async function setupRepo(): Promise<string> {
  const repoRoot = await createTempDir('kb-e2e-repo-');
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });

  await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
  await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'), HO_TEST_CONTENT, 'utf8');
  await writeFile(join(repoRoot, 'README.md'), 'kb-e2e-fixture: a minimal fixture repo.\n', 'utf8');

  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
  return repoRoot;
}

// ---------------------------------------------------------------------------
// Full pipeline chain — happy path
// ---------------------------------------------------------------------------

describe('dispatch v2 e2e (fake-tier) — full pipeline chain', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await setupRepo();
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('chains parse -> admission -> model -> assemble -> invocation -> jail -> enumerate -> checks -> delivery -> capture into a well-formed delivered response doc', async () => {
    const runDir = await createTempDir('kb-e2e-rundir-');
    try {
      // 1. Parse HO
      const parsed = await parseHandoff(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const handoff = parsed.data;
      expect(handoff.id).toBe('HO-TEST');
      expect(handoff.mode).toBe('implement');

      // 2. Admission (clean repo -> resolves baseSha to HEAD)
      const admission = await checkAdmission(handoff, repoRoot);
      expect(admission.ok).toBe(true);
      if (!admission.ok) return;
      expect(admission.data.baseSha).toMatch(/^[0-9a-f]{40}$/);

      // 3. Resolve model
      const modelResult = resolveModel(getDefaultRegistry(), 'deepseek');
      expect(modelResult.ok).toBe(true);
      if (!modelResult.ok) return;
      const model = modelResult.data;

      // 7. Assemble prompt
      const assembled = await assemblePrompt(handoff, repoRoot);
      expect(assembled.ok).toBe(true);
      if (!assembled.ok) return;
      expect(assembled.data.text).toContain('## Task: Add a greet utility with node:test coverage');
      expect(assembled.data.text).toContain('kb-e2e-fixture');

      // 8. Write prompt to the (fake) run dir; convert to its WSL2-equivalent path
      const promptPath = join(runDir, 'prompt.txt');
      await writeFile(promptPath, assembled.data.text, 'utf8');
      const promptPathWsl = windowsToWslPath(promptPath);
      expect(promptPathWsl.startsWith('/')).toBe(true);

      // 9/10. Fake clone path (no real WSL2 clone) + Pi invocation shape
      const clonePath = '/home/tester/.kb-dispatch/clones/RUN-e2e-fake';
      const workerDir = `${clonePath}/.pi-agent`;
      const invocation = buildInvocation(promptPathWsl, model, clonePath, workerDir);
      expect(invocation.cmd).toBe('pi');
      expect(invocation.args).toContain(`@${promptPathWsl}`);
      expect(invocation.env.PI_CODING_AGENT_DIR).toBe(workerDir);
      expect(invocation.cwd).toBe(clonePath);

      // 12. Jail args, then the full worker argv pipeline.ts would build
      const jailArgs = buildJailArgs({ clonePath });
      expect(jailArgs.argv[0]).toBe('bwrap');
      expect(jailArgs.argv[jailArgs.argv.length - 1]).toBe('--');
      const fullArgv = [...jailArgs.argv, invocation.cmd, ...invocation.args];
      expect(fullArgv).toContain('pi');
      expect(fullArgv[fullArgv.length - 1]).toBe(`@${promptPathWsl}`);

      // 16. Enumerate — simulate the WSL2 script's stdout for a worker that
      // created two new, in-scope files (new files show up as untracked, not
      // in `git diff`, which stays empty here).
      const enumerateScript = buildEnumerateScript(clonePath);
      expect(enumerateScript.scriptName).toBe('dispatch-enumerate.sh');
      const fakeEnumerateStdout = [
        '---STATUS-START---',
        '?? src/greet.mjs',
        '?? test/greet.test.mjs',
        '---STATUS-END---',
        '---RENAME-START---',
        '---RENAME-END---',
        '---DIFF-START---',
        '---DIFF-END---',
        '---UNTRACKED-START---',
        'src/greet.mjs',
        'test/greet.test.mjs',
        '---UNTRACKED-END---',
      ].join('\n');
      const enumerated = parseEnumerateOutput(fakeEnumerateStdout);
      expect(enumerated.untrackedFiles).toEqual(['src/greet.mjs', 'test/greet.test.mjs']);
      const allChangedFiles = [...enumerated.changedFiles, ...enumerated.untrackedFiles];

      // 17. Write scope + secret checks — both clean
      const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);
      expect(scopeCheck.ok).toBe(true);
      const secretCheck = scanSecrets(enumerated.diff);
      expect(secretCheck.ok).toBe(true);

      // 18. Delivery script shape
      const deliveryScript = buildDeliveryScript({
        clonePath,
        motherRepoWsl: windowsToWslPath(repoRoot),
        handoffId: handoff.id,
        baseSha: admission.data.baseSha,
      });
      expect(deliveryScript.scriptName).toBe('dispatch-deliver.sh');
      expect(deliveryScript.scriptContent).toContain("HANDOFF_ID='HO-TEST'");
      expect(deliveryScript.scriptContent).toContain(admission.data.baseSha);

      // 19. Parse delivery output — simulate a successfully landed commit
      const fakeDeliveryStdout = [
        'DELIVERED:deadbeef1234',
        '---BRANCH-START---',
        'dispatch/HO-TEST',
        '---BRANCH-END---',
        '---CHANGED-FILES-START---',
        'src/greet.mjs',
        'test/greet.test.mjs',
        '---CHANGED-FILES-END---',
      ].join('\n');
      const delivery: DeliveryOutcome = parseDeliveryOutput(fakeDeliveryStdout);
      expect(delivery.status).toBe('delivered');
      if (delivery.status !== 'delivered') return;
      expect(delivery.branch).toBe('dispatch/HO-TEST');
      expect(delivery.changedFiles).toEqual(['src/greet.mjs', 'test/greet.test.mjs']);

      // 20. Capture
      const canonicalModel = `${model.provider}/${model.modelId}`;
      const captureResult = await writeResponseDoc({
        runDir,
        handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
        delivery,
        piResult: { outcome: 'completed', usage: { totalTokens: 321, costUsd: 0.0042 } },
        model: canonicalModel,
        isolationBackend: 'bwrap-wsl2',
      });
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;

      const onDisk = await readFile(captureResult.data.responsePath, 'utf8');
      expect(onDisk).toBe(captureResult.data.responseContent);
      expect(onDisk).toContain('handoff_id: HO-TEST');
      expect(onDisk).toContain('outcome: completed');
      expect(onDisk).toContain(`model: ${canonicalModel}`);
      expect(onDisk).toContain('isolation_backend: bwrap-wsl2');
      expect(onDisk).toContain('branch: dispatch/HO-TEST');
      expect(onDisk).toContain('# Response: Add a greet utility with node:test coverage');
      expect(onDisk).toContain('## Outcome');
      expect(onDisk).toContain('- src/greet.mjs');
      expect(onDisk).toContain('- test/greet.test.mjs');
      expect(onDisk).toContain('## Usage');
      expect(onDisk).toContain('- Tokens: 321');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('admission refuses a dirty repo before any downstream step would run', async () => {
    await writeFile(join(repoRoot, 'README.md'), 'modified without committing\n', 'utf8');

    const parsed = await parseHandoff(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const admission = await checkAdmission(parsed.data, repoRoot);
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.error).toBe('DIRTY_REPO');
    expect(admission.detail).toMatchObject({ dirtyPaths: expect.arrayContaining([expect.stringContaining('README.md')]) });
  });

  it('write-scope check catches an out-of-scope file from a simulated enumerate, and the refusal produces a well-formed response doc', async () => {
    const runDir = await createTempDir('kb-e2e-scope-');
    try {
      const parsed = await parseHandoff(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const handoff = parsed.data;

      const fakeEnumerateStdout = [
        '---STATUS-START---',
        '?? src/greet.mjs',
        '?? lib/evil.mjs',
        '---STATUS-END---',
        '---RENAME-START---',
        '---RENAME-END---',
        '---DIFF-START---',
        '---DIFF-END---',
        '---UNTRACKED-START---',
        'src/greet.mjs',
        'lib/evil.mjs',
        '---UNTRACKED-END---',
      ].join('\n');
      const enumerated = parseEnumerateOutput(fakeEnumerateStdout);
      const allChangedFiles = [...enumerated.changedFiles, ...enumerated.untrackedFiles];

      const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);
      expect(scopeCheck.ok).toBe(false);
      if (scopeCheck.ok) return;
      expect(scopeCheck.offendingPaths).toEqual(['lib/evil.mjs']);

      const quarantinePath = join(runDir, 'quarantine.diff');
      await writeFile(quarantinePath, enumerated.diff, 'utf8');
      const delivery: DeliveryOutcome = {
        status: 'refused_out_of_scope',
        offendingPaths: scopeCheck.offendingPaths,
        quarantinePath,
      };

      const captureResult = await writeResponseDoc({
        runDir,
        handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
        delivery,
      });
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;
      expect(captureResult.data.responseContent).toContain('outcome: refused');
      expect(captureResult.data.responseContent).toContain('lib/evil.mjs');
      expect(captureResult.data.responseContent).toContain('changed_files: []');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('secret scan catches a seeded key pattern from a simulated enumerate, and the refusal produces a well-formed response doc', async () => {
    const runDir = await createTempDir('kb-e2e-secret-');
    try {
      const parsed = await parseHandoff(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const handoff = parsed.data;

      // Seeded with AWS's own documented example-only placeholder key — never a
      // real-looking live key (matches the wave-2 delivery test convention).
      const fakeDiff = [
        'diff --git a/src/greet.mjs b/src/greet.mjs',
        '+const key = "AKIAIOSFODNN7EXAMPLE"; // seeded example-only key',
      ].join('\n');
      const fakeEnumerateStdout = [
        '---STATUS-START---',
        ' M src/greet.mjs',
        '---STATUS-END---',
        '---RENAME-START---',
        '---RENAME-END---',
        '---DIFF-START---',
        fakeDiff,
        '---DIFF-END---',
        '---UNTRACKED-START---',
        '---UNTRACKED-END---',
      ].join('\n');
      const enumerated = parseEnumerateOutput(fakeEnumerateStdout);
      const allChangedFiles = [...enumerated.changedFiles, ...enumerated.untrackedFiles];

      const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);
      expect(scopeCheck.ok).toBe(true);

      const secretCheck = scanSecrets(enumerated.diff);
      expect(secretCheck.ok).toBe(false);
      if (secretCheck.ok) return;
      expect(secretCheck.patterns).toContain('aws_access_key_id');

      const quarantinePath = join(runDir, 'quarantine.diff');
      await writeFile(quarantinePath, enumerated.diff, 'utf8');
      const delivery: DeliveryOutcome = { status: 'secret_in_diff', patterns: secretCheck.patterns, quarantinePath };

      const captureResult = await writeResponseDoc({
        runDir,
        handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
        delivery,
      });
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;
      expect(captureResult.data.responseContent).toContain('outcome: refused');
      expect(captureResult.data.responseContent).toContain('aws_access_key_id');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Delivery script parse — DELIVERED / IDEMPOTENT / CONFLICT
// ---------------------------------------------------------------------------

describe('parseDeliveryOutput — DELIVERED / IDEMPOTENT / CONFLICT', () => {
  it('parses a DELIVERED outcome', () => {
    const result = parseDeliveryOutput('DELIVERED:abc123');
    expect(result.status).toBe('delivered');
    if (result.status !== 'delivered') return;
    expect(result.commitSha).toBe('abc123');
  });

  it('parses an IDEMPOTENT outcome as a no_changes redelivery no-op', () => {
    const result = parseDeliveryOutput('IDEMPOTENT');
    expect(result.status).toBe('no_changes');
  });

  it('parses a CONFLICT outcome', () => {
    const result = parseDeliveryOutput('CONFLICT:def456');
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.existingTree).toBe('def456');
  });
});

// ---------------------------------------------------------------------------
// writeResponseDoc — well-formed markdown for every terminal delivery outcome
// ---------------------------------------------------------------------------

describe('writeResponseDoc — well-formed markdown for every terminal delivery outcome', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-e2e-capture-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; delivery: DeliveryOutcome }> = [
    { name: 'no_changes', delivery: { status: 'no_changes' } },
    { name: 'conflict', delivery: { status: 'conflict', existingTree: 'aaa111', newTree: 'bbb222' } },
    { name: 'error', delivery: { status: 'error', message: 'boom' } },
  ];

  for (const { name, delivery } of cases) {
    it(`produces well-formed markdown for a ${name} outcome`, async () => {
      const result = await writeResponseDoc({
        runDir,
        handoff: { id: 'HO-TEST', title: 'Add a greet utility with node:test coverage', mode: 'implement' },
        delivery,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.responseContent.startsWith('---\n')).toBe(true);
      expect(result.data.responseContent).toContain('# Response: Add a greet utility with node:test coverage');
      expect(result.data.responseContent).toContain('## Outcome');
      expect(result.data.responseContent).toContain('## Changed Files');
      expect(result.data.responseContent).toContain('## Usage');

      const onDisk = await readFile(result.data.responsePath, 'utf8');
      expect(onDisk).toBe(result.data.responseContent);
    });
  }
});

// ---------------------------------------------------------------------------
// preflight.ts — parsePreflightOutput (pure, no WSL2/bwrap host required)
// ---------------------------------------------------------------------------

describe('preflight.ts — parsePreflightOutput (T27, pure parsing)', () => {
  it('reports no remediation needed when bwrap works and unshare-user succeeds', () => {
    const stdout = [
      'BWRAP_PATH=/usr/bin/bwrap',
      'BWRAP_VERSION=bubblewrap 0.8.0',
      'UNSHARE_USER=OK',
      'APPARMOR_USERNS=0',
    ].join('\n');

    const result = parsePreflightOutput(stdout);
    expect(result.bwrapAvailable).toBe(true);
    expect(result.unshareUserWorks).toBe(true);
    expect(result.appArmorRestriction).toBe(false);
    expect(result.remediationNeeded).toBe(false);
    expect(result.remediationText).toBeUndefined();
  });

  it('flags remediation needed with the exact remediation text when bwrap is missing', () => {
    const stdout = [
      'BWRAP_PATH=MISSING',
      'BWRAP_VERSION=MISSING',
      'UNSHARE_USER=FAIL',
      'APPARMOR_USERNS=N/A',
    ].join('\n');

    const result = parsePreflightOutput(stdout);
    expect(result.bwrapAvailable).toBe(false);
    expect(result.remediationNeeded).toBe(true);
    expect(result.remediationText).toContain('/etc/apparmor.d/bwrap');
    expect(result.remediationText).toContain('userns,');
    expect(result.remediationText).toContain('systemctl reload apparmor');
  });

  it('flags remediation needed when the live unshare-user probe fails despite bwrap being present (Ubuntu 24.04 AppArmor userns restriction)', () => {
    const stdout = [
      'BWRAP_PATH=/usr/bin/bwrap',
      'BWRAP_VERSION=bubblewrap 0.8.0',
      'UNSHARE_USER=FAIL',
      'APPARMOR_USERNS=1',
    ].join('\n');

    const result = parsePreflightOutput(stdout);
    expect(result.bwrapAvailable).toBe(true);
    expect(result.unshareUserWorks).toBe(false);
    expect(result.appArmorRestriction).toBe(true);
    expect(result.remediationNeeded).toBe(true);
  });
});
