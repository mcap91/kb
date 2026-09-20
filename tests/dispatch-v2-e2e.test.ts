/**
 * PLN-0004 S0 Wave 3 — end-to-end fake-tier pipeline test.
 *
 * Chains the wave-1/wave-2 skeleton modules in the same order `pipeline.ts`'s
 * `runDispatch()` wires them, WITHOUT any real WSL2/bwrap/Pi (a "fake tier"):
 * parseHandoff -> checkAdmission -> resolveModel -> assemblePrompt ->
 * buildInvocation -> buildJailArgs -> buildEnumerateScript -> checkWriteScope
 * -> injected-value scan -> buildDeliveryScript -> parseDeliveryOutput ->
 * writeResponseDoc. The two points that would normally run inside WSL2
 * (enumerate + delivery) are simulated by hand-constructing the exact stdout
 * shape their scripts produce and feeding it through the real parsers — this
 * validates the ORCHESTRATION/wiring, not a live host. `runDispatch()` itself
 * is never called here for these two legs (it needs a live WSL2/bwrap/Pi
 * host); that live gate is a separate, manually-run proof
 * (execution/s0-rulings.md).
 *
 * S3 (s3-rulings.md freeze correction) removed the S0-era pattern-only
 * `scanSecrets()` leg from pipeline.ts's delivery gate and replaced it with a
 * deterministic scan for granted credentials' literal values
 * (`buildInjectedValueScanFragment` / `parseInjectedValueScanOutput`,
 * credentials.ts): the fragment is spliced onto the SAME enumerate script
 * pipeline.ts already runs, and reports `SECRET_HIT=<VAR_NAME>` — names only,
 * never values. `scanSecrets()` itself is unchanged and still directly
 * unit-tested in dispatch-v2-delivery.test.ts; it is simply no longer wired
 * into pipeline.ts's own delivery-gate decision.
 *
 * No personal/absolute paths appear in fixtures (WK-0043 rule); all
 * filesystem tests use temp dirs. The seeded credential-value fixture below
 * is an obvious placeholder string, never a real-looking live token.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHandoff } from '../packages/dispatch-core/src/ho.js';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { getDefaultRegistry, resolveModel } from '../packages/dispatch-core/src/model-registry.js';
import { assemblePrompt } from '../packages/dispatch-core/src/assemble.js';
import { buildInvocation } from '../packages/dispatch-core/src/adapters/pi.js';
import { buildJailArgs } from '../packages/dispatch-core/src/jail.js';
import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  buildDeliveryScript,
  parseDeliveryOutput,
  type DeliveryOutcome,
} from '../packages/dispatch-core/src/delivery.js';
import {
  buildInjectedValueScanFragment,
  parseInjectedValueScanOutput,
  type CredentialResolution,
} from '../packages/dispatch-core/src/credentials.js';
import { writeResponseDoc } from '../packages/dispatch-core/src/capture.js';
import { parsePreflightOutput } from '../packages/dispatch-core/src/preflight.js';
import * as preflightModule from '../packages/dispatch-core/src/preflight.js';
import * as tierModule from '../packages/dispatch-core/src/tier.js';
import * as spawnIsolatedModule from '../packages/dispatch-core/src/spawn-isolated.js';
import { runDispatch } from '../packages/dispatch-core/src/pipeline.js';

function readFixtureFile(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

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
work_item: WK-9004
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

  // WK-0116: HO-TEST is mode=implement, so it must declare a work_item resolving
  // to a real initiative, or admission trips WORK_ITEM_NOT_FOUND before this
  // full-pipeline-chain test ever reaches baseSha resolution.
  await mkdir(join(repoRoot, 'wiki', 'issues'), { recursive: true });
  await writeFile(
    join(repoRoot, 'wiki', 'issues', 'WK-9004.md'),
    '---\nid: "WK-9004"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9004\n---\n\n# WK-9004: Fixture\n',
    'utf8',
  );
  await mkdir(join(repoRoot, 'wiki', 'initiatives'), { recursive: true });
  await writeFile(
    join(repoRoot, 'wiki', 'initiatives', 'IN-9004.md'),
    '---\nid: "IN-9004"\ntitle: "Fixture initiative"\nstatus: todo\n---\n\n# IN-9004: Fixture\n',
    'utf8',
  );

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

      // 8. Write prompt to the (fake) run dir — a plain host path (D6: no more WSL2 path conversion)
      const promptPath = join(runDir, 'prompt.txt');
      await writeFile(promptPath, assembled.data.text, 'utf8');
      expect(promptPath.startsWith('/')).toBe(true);

      // 9/10. Fake clone path (no real clone) + Pi invocation shape
      const clonePath = '/home/tester/.kb-dispatch/clones/RUN-e2e-fake';
      const workerDir = `${clonePath}/.pi-agent`;
      const invocation = buildInvocation(promptPath, model, clonePath, workerDir);
      expect(invocation.cmd).toBe('pi');
      expect(invocation.args).toContain(`@${promptPath}`);
      expect(invocation.env.PI_CODING_AGENT_DIR).toBe(workerDir);
      expect(invocation.cwd).toBe(clonePath);

      // 12. Jail args, then the full worker argv pipeline.ts would build
      const jailArgs = buildJailArgs({ clonePath });
      expect(jailArgs.argv[0]).toBe('bwrap');
      expect(jailArgs.argv[jailArgs.argv.length - 1]).toBe('--');
      const fullArgv = [...jailArgs.argv, invocation.cmd, ...invocation.args];
      expect(fullArgv).toContain('pi');
      expect(fullArgv[fullArgv.length - 1]).toBe(`@${promptPath}`);

      // 16. Enumerate — simulate the enumerate script's stdout for a worker that
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

      // 17. Write scope + injected-value scan — both clean. HO-TEST grants no
      // credentials, so pipeline.ts would never splice scan lines onto the
      // enumerate script for this run at all; parseInjectedValueScanOutput
      // correctly reports no hits against this fake stdout either way.
      const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);
      expect(scopeCheck.ok).toBe(true);
      const secretHits = parseInjectedValueScanOutput(fakeEnumerateStdout);
      expect(secretHits).toEqual([]);

      // 18. Delivery script shape
      const deliveryScript = buildDeliveryScript({
        clonePath,
        motherRepoWsl: repoRoot,
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
      expect(onDisk).toContain('outcome: delivered');
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

  it('injected-value scan (S3) catches a granted credential value from a simulated enumerate, and the refusal produces a well-formed response doc', async () => {
    const runDir = await createTempDir('kb-e2e-secret-');
    try {
      const parsed = await parseHandoff(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const handoff = parsed.data;

      // Exercise the REAL builder pipeline.ts calls — proves the fragment
      // this test simulates the output of is the one wiring actually
      // produces, not a hand-rolled stand-in (dispatch-v2-credentials.test.ts
      // pins its exact line shape at the unit level; this proves the WIRING).
      const resolution: CredentialResolution = {
        granted: ['hf'],
        injections: [{ profileName: 'hf', varName: 'HF_TOKEN', filePath: '/home/operator/.secrets/hf-token.env' }],
        backendApiKeyEnv: null,
        backendSecretsFile: null,
        credentialEndpoints: [],
      };
      const valueScanLines = buildInjectedValueScanFragment(resolution);
      expect(valueScanLines.length).toBeGreaterThan(0);

      // Simulate the WSL2-side enumerate script's stdout as if the spliced
      // fragment above ran against a diff containing the granted credential's
      // value: a `SECRET_HIT=<VAR_NAME>` line, name only, appended after the
      // marker-delimited sections (exactly where pipeline.ts's splice puts
      // it). The diff body uses an obvious placeholder string, never a
      // real-looking live token.
      const fakeEnumerateStdout = [
        '---STATUS-START---',
        ' M src/greet.mjs',
        '---STATUS-END---',
        '---RENAME-START---',
        '---RENAME-END---',
        '---DIFF-START---',
        'diff --git a/src/greet.mjs b/src/greet.mjs',
        '+const token = "hf_seeded_example_placeholder_only";',
        '---DIFF-END---',
        '---UNTRACKED-START---',
        '---UNTRACKED-END---',
        'SECRET_HIT=HF_TOKEN',
      ].join('\n');
      const enumerated = parseEnumerateOutput(fakeEnumerateStdout);
      const allChangedFiles = [...enumerated.changedFiles, ...enumerated.untrackedFiles];

      const scopeCheck = checkWriteScope(allChangedFiles, handoff.write_scope);
      expect(scopeCheck.ok).toBe(true);

      // The trailing SECRET_HIT line coexists with the marker-delimited
      // sections in the same stdout string without corrupting either parse —
      // the exact invariant pipeline.ts relies on.
      const secretHits = parseInjectedValueScanOutput(fakeEnumerateStdout);
      expect(secretHits).toEqual(['HF_TOKEN']);

      const quarantinePath = join(runDir, 'quarantine.diff');
      await writeFile(quarantinePath, enumerated.diff, 'utf8');
      const delivery: DeliveryOutcome = { status: 'secret_in_diff', patterns: secretHits, quarantinePath };

      const captureResult = await writeResponseDoc({
        runDir,
        handoff: { id: handoff.id, title: handoff.title, mode: handoff.mode },
        delivery,
      });
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;
      expect(captureResult.data.responseContent).toContain('outcome: refused');
      expect(captureResult.data.responseContent).toContain('HF_TOKEN');
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

  it('captures piVersion when PI_VERSION is present (S3 ruling 7)', () => {
    const stdout = [
      'BWRAP_PATH=/usr/bin/bwrap',
      'BWRAP_VERSION=bubblewrap 0.8.0',
      'PI_VERSION=1.2.3',
      'UNSHARE_USER=OK',
      'APPARMOR_USERNS=0',
    ].join('\n');

    const result = parsePreflightOutput(stdout);
    expect(result.piVersion).toBe('1.2.3');
  });

  it('omits piVersion when PI_VERSION=MISSING', () => {
    const stdout = [
      'BWRAP_PATH=/usr/bin/bwrap',
      'BWRAP_VERSION=bubblewrap 0.8.0',
      'PI_VERSION=MISSING',
      'UNSHARE_USER=OK',
      'APPARMOR_USERNS=0',
    ].join('\n');

    const result = parsePreflightOutput(stdout);
    expect(result.piVersion).toBeUndefined();
    expect('piVersion' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PLN-0004 S3 Wave 3 — pipeline.ts integration: synchronous refusal gates.
//
// Each scenario below calls the REAL `runDispatch()`, but every one of them
// refuses before the pipeline ever creates a clone or touches WSL2/bwrap/Pi
// (the effort gate, credential resolution, and credential policy check all
// run before "5. Run ID" / "9. Clone" in pipeline.ts) — so these stay
// fake-tier despite exercising the real integrated pipeline, not simulated
// stdout like the chain test above. No personal/absolute paths in fixtures
// (WK-0043 rule); all filesystem tests use temp dirs.
// ---------------------------------------------------------------------------

interface S3RepoOpts {
  credentials?: string[];
  web?: boolean;
  vars?: string[];
  models?: Record<string, unknown>;
  backends?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
}

/** A clean, committed temp repo with an HO fixture + wiki/.dispatch/ tables (S3 ruling 1). */
async function setupS3Repo(opts: S3RepoOpts = {}): Promise<string> {
  const repoRoot = await createTempDir('kb-e2e-s3-repo-');
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });

  const { credentials = [], web = false, vars = [] } = opts;
  const hoContent = `---
id: HO-S3TEST
title: S3 wave 3 refusal-gate fixture
mode: implement
write_scope: ["src/"]
base_ref: null
web: ${web}
credentials: ${JSON.stringify(credentials)}
data_mounts: []
read_first: []
vars: ${JSON.stringify(vars)}
work_item: WK-9003
acceptance:
  - "AC-1: placeholder — this HO is never actually dispatched to a worker"
validation: ["node --test test/"]
status: draft
---

## Task
Placeholder fixture. Every S3 wave 3 refusal-gate test returns before any
clone/jail/worker step runs, so this body is never read by a worker.
`;

  await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
  await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-S3TEST.md'), hoContent, 'utf8');
  await writeFile(join(repoRoot, 'README.md'), 'kb-e2e-s3-fixture: a minimal fixture repo.\n', 'utf8');

  // WK-0116: the fixture HO is mode=implement, so it must declare a work_item
  // resolving to a real initiative, or every test below trips WORK_ITEM_NOT_FOUND
  // before ever reaching the gate under test.
  await mkdir(join(repoRoot, 'wiki', 'issues'), { recursive: true });
  await writeFile(
    join(repoRoot, 'wiki', 'issues', 'WK-9003.md'),
    '---\nid: "WK-9003"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9003\n---\n\n# WK-9003: Fixture\n',
    'utf8',
  );
  await mkdir(join(repoRoot, 'wiki', 'initiatives'), { recursive: true });
  await writeFile(
    join(repoRoot, 'wiki', 'initiatives', 'IN-9003.md'),
    '---\nid: "IN-9003"\ntitle: "Fixture initiative"\nstatus: todo\n---\n\n# IN-9003: Fixture\n',
    'utf8',
  );

  await mkdir(join(repoRoot, 'wiki', '.dispatch'), { recursive: true });
  const models = opts.models ?? {
    deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731' },
  };
  const backends = opts.backends ?? {
    openrouter: { family: 'pi', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', secrets_file: null },
  };
  const profiles = opts.profiles ?? { schema_version: 1 };
  await writeFile(join(repoRoot, 'wiki', '.dispatch', 'models.json'), JSON.stringify(models, null, 2), 'utf8');
  await writeFile(join(repoRoot, 'wiki', '.dispatch', 'backends.json'), JSON.stringify(backends, null, 2), 'utf8');
  await writeFile(join(repoRoot, 'wiki', '.dispatch', 'profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');

  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
  return repoRoot;
}

describe('dispatch v2 e2e (fake-tier) — S3 wave 3 refusal gates (real runDispatch())', () => {
  it('refuses EFFORT_UNSUPPORTED when effort is requested and the resolved model/backend cannot carry it', async () => {
    const repoRoot = await setupS3Repo();
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'deepseek',
        backend: 'openrouter',
        effort: 'high',
        preflight: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('EFFORT_UNSUPPORTED');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses CREDENTIALS_WITH_WEB when a granted credential profile is combined with web:true', async () => {
    const repoRoot = await setupS3Repo({
      credentials: ['hf'],
      web: true,
      profiles: { schema_version: 1, hf: { inject: { HF_TOKEN: '/home/operator/.secrets/hf-token.env' } } },
    });
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'deepseek',
        backend: 'openrouter',
        preflight: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('CREDENTIALS_WITH_WEB');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses UNKNOWN_PROFILE when the handoff names a profile absent from profiles.json', async () => {
    const repoRoot = await setupS3Repo({ credentials: ['nonexistent'] });
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'deepseek',
        backend: 'openrouter',
        preflight: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('UNKNOWN_PROFILE');
      expect(result.message).toContain('nonexistent');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('dispatch v2 e2e (fake-tier) — S3 wave 3 harness version gate (mocked preflight)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses PREFLIGHT_FAILED when the probed Pi version is below the known-good floor', async () => {
    vi.spyOn(preflightModule, 'runPreflight').mockResolvedValue({
      ok: true,
      data: {
        bwrapAvailable: true,
        unshareUserWorks: true,
        appArmorRestriction: false,
        remediationNeeded: false,
        piVersion: '0.80.0',
      },
    });

    const repoRoot = await setupS3Repo();
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'deepseek',
        backend: 'openrouter',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('PREFLIGHT_FAILED');
      expect(result.message).toContain('0.80.0');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PLN-0004 S5/D6 — pipeline.ts isolation-route integration: honest
// isolationBackend provenance, not a hardcoded string.
//
// This is the one wiring point that genuinely needs a real `runDispatch()`
// call — it proves `probeBwrap()` is wired for real and that the
// NO_ISOLATION_ROUTE refusal is actually reachable through the integrated
// pipeline, mirroring the harness-version-gate test above (same
// `vi.spyOn(...)` technique, now targeting tier.ts's `probeBwrap` directly —
// D6 replaced the old resolveTier(tierProbes-derived-from-mocked-preflight)
// gate with an unconditional, directly-probed boolean gate, so mocking
// `runPreflight` alone no longer reaches it; `runPreflight` runs for real
// here and is expected to pass on any host with working bwrap).
// ---------------------------------------------------------------------------

describe('dispatch v2 e2e (fake-tier) — isolation route (mocked bwrap probe)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses NO_ISOLATION_ROUTE when the bwrap probe reports unavailable, proving the isolation gate is wired for real', async () => {
    vi.spyOn(tierModule, 'probeBwrap').mockResolvedValue({
      available: false,
      bwrapVersion: null,
      unshareUserWorks: false,
      kernelVersion: 'test-kernel',
      usernsSysctl: null,
    });

    const repoRoot = await setupS3Repo();
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'deepseek',
        backend: 'openrouter',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('NO_ISOLATION_ROUTE');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// WK-0122 — effort passthrough, full runDispatch() (mocked spawnIsolated).
//
// spawnIsolated (spawn-isolated.ts) is the one seam that needs a live
// bwrap+worker-CLI host to run for real (D6's direct spawn, no script
// indirection) — mocking just that seam mirrors this file's own established
// technique for probeBwrap/runPreflight above. Everything else (clone
// creation, jail-plan build, enumerate, delivery, capture) runs for REAL
// against a real temp git repo, so these tests exercise the actual step-10
// config-driven effort splice into pipeline.ts's hand-built exec line and
// the step-20 effort_requested threading into capture.ts — not a simulation
// of that wiring. The mocked worker "output" written to pi-output.log is the
// real DEC-0009 golden fixture content (tests/fixtures/claude-p-output.txt /
// codex-exec-output-stream-json.jsonl) — no hand-invented shape (DEC-0009).
// The clone tree is never actually mutated (the mock never touches the
// filesystem the worker would have written to), so delivery always resolves
// 'no_delta' here; that's expected and irrelevant to what these tests check
// (capture.ts writes effort_requested unconditionally, regardless of
// delivery outcome).
// ---------------------------------------------------------------------------

describe('dispatch v2 e2e (fake-tier) — WK-0122 effort passthrough (mocked spawnIsolated)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mock spawnIsolated: capture the bwrap plan's command (`plan.command[2]`
   * is the innerScript bash string pipeline.ts builds at step 10-12c, which
   * embeds the exec line under test), write a real golden fixture to the
   * requested stdoutLogPath as the "worker output", and resolve as a clean,
   * un-truncated, non-timed-out exit — exactly the shape spawnIsolated
   * itself returns for a worker that ran to completion.
   */
  function mockSpawnIsolated(fixtureContent: string): { getInnerScript: () => string | undefined } {
    let capturedInnerScript: string | undefined;
    vi.spyOn(spawnIsolatedModule, 'spawnIsolated').mockImplementation(async (plan, opts) => {
      capturedInnerScript = plan.command[2];
      if (opts?.stdoutLogPath) {
        await writeFile(opts.stdoutLogPath, fixtureContent, 'utf8');
      }
      return {
        ok: true,
        data: {
          stdout: '',
          stderr: '',
          exitCode: 0,
          signal: null,
          truncated: false,
          timedOut: false,
          streamDrainTimedOut: false,
        },
      };
    });
    return { getInnerScript: () => capturedInnerScript };
  }

  it('claude backend with effort_mapping: effort spliced into the exec line + effort_requested in the response doc', async () => {
    const repoRoot = await setupS3Repo({
      backends: {
        'claude-saas': {
          family: 'claude',
          base_url: null,
          api_key_env: null,
          secrets_file: null,
          effort_mapping: { flag: '--effort', style: 'flag_value' },
        },
      },
      models: {
        'claude-sonnet-5': { available_on: ['claude-saas'], model_id: 'claude-sonnet-5' },
      },
    });
    const { getInnerScript } = mockSpawnIsolated(readFixtureFile('claude-p-output.txt'));
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'claude-sonnet-5',
        backend: 'claude-saas',
        effort: 'high',
        preflight: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const innerScript = getInnerScript();
      expect(innerScript).toBeDefined();
      // Each token is single-quoted for safe bash embedding (pipeline.ts's
      // shQuote), so the spliced pair reads as '--effort' 'high', not a bare
      // '--effort high'.
      expect(innerScript).toContain("'--effort' 'high'");
      // The prompt must stay the LAST positional arg after -- (DEC-0024) —
      // effort must land BEFORE the terminator, never smuggled in after it.
      const effortIdx = innerScript!.indexOf("'--effort'");
      const terminatorIdx = innerScript!.indexOf('-- "$PROMPT"');
      expect(terminatorIdx).toBeGreaterThan(-1);
      expect(effortIdx).toBeLessThan(terminatorIdx);

      const responseContent = await readFile(result.data.responsePath, 'utf8');
      expect(responseContent).toContain('effort_requested: high');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('codex backend with effort_mapping: effort spliced as -c model_reasoning_effort=<level> into the exec line', async () => {
    const repoRoot = await setupS3Repo({
      backends: {
        'codex-saas': {
          family: 'codex',
          base_url: null,
          api_key_env: null,
          secrets_file: null,
          effort_mapping: { flag: '-c', style: 'key_equals_value', key: 'model_reasoning_effort' },
        },
      },
      models: {
        'gpt-5.5': { available_on: ['codex-saas'], model_id: 'gpt-5.5' },
      },
    });
    const { getInnerScript } = mockSpawnIsolated(readFixtureFile('codex-exec-output-stream-json.jsonl'));
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'gpt-5.5',
        backend: 'codex-saas',
        effort: 'high',
        preflight: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const innerScript = getInnerScript();
      expect(innerScript).toBeDefined();
      // Each token is single-quoted for safe bash embedding (pipeline.ts's
      // shQuote); the value itself carries no internal quotes (WK-0069 note).
      expect(innerScript).toContain("'-c' 'model_reasoning_effort=high'");

      const responseContent = await readFile(result.data.responsePath, 'utf8');
      expect(responseContent).toContain('effort_requested: high');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('without --effort: no splice in the exec line, empty effort_requested in the response doc (no regression)', async () => {
    const repoRoot = await setupS3Repo({
      backends: {
        'claude-saas': {
          family: 'claude',
          base_url: null,
          api_key_env: null,
          secrets_file: null,
          effort_mapping: { flag: '--effort', style: 'flag_value' },
        },
      },
      models: {
        'claude-sonnet-5': { available_on: ['claude-saas'], model_id: 'claude-sonnet-5' },
      },
    });
    const { getInnerScript } = mockSpawnIsolated(readFixtureFile('claude-p-output.txt'));
    try {
      const result = await runDispatch({
        dir: repoRoot,
        handoff: 'wiki/handoffs/HO-S3TEST.md',
        model: 'claude-sonnet-5',
        backend: 'claude-saas',
        preflight: false,
        // effort intentionally omitted — proves "mapping present but effort
        // not requested" still produces no splice (not just "no mapping").
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const innerScript = getInnerScript();
      expect(innerScript).toBeDefined();
      expect(innerScript).not.toContain('--effort');

      const responseContent = await readFile(result.data.responsePath, 'utf8');
      expect(responseContent).toContain('effort_requested: \n');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
