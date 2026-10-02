/**
 * WK-0183 — tests for `explore_code`, the fifth dispatch mode (DEC-0043: brute-force
 * addition, mirrors `research` throughout). Covers:
 *  - assemble.ts: `getModeParts()` produces the correct `ModeParts` shape
 *    (includeWriteScope: false, includeAcceptance: true, includeValidation: false)
 *    and the `explorer`-role recovery-block instruction.
 *  - admission.ts: explore_code passes the envelope check; write_scope and web:true
 *    both trip `ENVELOPE_EXCEEDS_MODE`.
 *  - capture.ts: `deriveVerdict` derives `delivered` for a clean run and
 *    `failed`/`process_error` for a crashed process (mirrors research exactly).
 *  - recovery-block.ts: `reported_role: "explorer"` is accepted by
 *    `validateRecoveryPayload` and participates in the findings-outcome vocabulary
 *    (the `isFindingsRole` OR-chain, HO-0064 F1 critical finding).
 *
 * NOTE (mirrors HO-0046 F1): this directory (`packages/dispatch-core/tests/`) is
 * not in vitest.config.ts's `include` glob (`tests/**\/*.test.ts`, repo-root-relative),
 * so this file is not discovered by `npm test` as committed. It was verified passing
 * out-of-band via `npx vitest run --config <temp-config> packages/dispatch-core/tests/explore-code.test.ts`
 * during authoring. Written at this path because it is the write_scope this HO grants;
 * moving it into the discovered `tests/` root is outside write_scope.
 *
 * No personal/absolute paths appear in fixtures (WK-0043 rule); all filesystem tests
 * use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHandoffContent, type Handoff } from '../src/ho.js';
import { checkAdmission } from '../src/admission.js';
import { assemblePrompt } from '../src/assemble.js';
import { writeResponseDoc } from '../src/capture.js';
import type { DeliveryOutcome } from '../src/delivery.js';
import { validateRecoveryPayload, KB_DISPATCH_RECOVERY_VERSION } from '../src/recovery-block.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-0002',
    title: 'Explore the auth module',
    mode: 'explore_code',
    write_scope: [],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: report findings on the auth module layout'],
    validation: ['npm run typecheck && npm test'],
    status: 'draft',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assemble.ts — explore_code ModeParts
// ---------------------------------------------------------------------------

function exploreCodeHoMarkdown(): string {
  return `---
id: HO-TEST
title: Explore the auth module
mode: explore_code
write_scope: []
base_ref: null
web: false
credentials: []
data_mounts: []
export_mounts: []
read_first: []
acceptance:
  - "AC-1: report findings on the auth module layout"
validation:
  - "npm run typecheck && npm test"
status: draft
---

Explore the auth module and report structured findings.
`;
}

describe('assemble.ts — explore_code mode framing (WK-0183)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await createTempDir('kb-assemble-explore-code-');
    await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function assembleExploreCode() {
    const content = exploreCodeHoMarkdown();
    await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'), content, 'utf8');
    const parsed = parseHandoffContent(content, 'HO-TEST.md');
    if (!parsed.ok) throw new Error(`fixture HO markdown failed to parse: ${parsed.message}`);
    return assemblePrompt(parsed.data, repoRoot);
  }

  it('excludes Write Scope and Validation but includes Acceptance Criteria', async () => {
    const result = await assembleExploreCode();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).not.toContain('Write Scope');
    expect(result.data.text).not.toContain('### Validation');
    expect(result.data.text).toContain('Acceptance Criteria');
  });

  it('casts the worker as a code explorer', async () => {
    const result = await assembleExploreCode();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('code explorer');
  });

  it('grants read-only repo access and forbids file modification', async () => {
    const result = await assembleExploreCode();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('read-only access to the full repository');
    expect(result.data.text).toContain('Do not modify any files');
  });

  it('includes the explorer-role recovery block instruction (findings-shaped, optional metadata)', async () => {
    const result = await assembleExploreCode();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).toContain('kb-dispatch-recovery.v1');
    expect(result.data.text).toContain('"reported_role": "explorer"');
    expect(result.data.text).toContain('Your prose review above is the primary deliverable');
    expect(result.data.text).not.toContain('This block IS your deliverable');
  });
});

// ---------------------------------------------------------------------------
// admission.ts — explore_code envelope checks
// ---------------------------------------------------------------------------

describe('admission.ts — explore_code envelope (WK-0183, ENVELOPE_EXCEEDS_MODE §7.2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dispatch-explore-code-'));
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    await writeFile(join(tempDir, 'README.md'), '# test');
    // `wiki/` must be tracked by the parent repo (not absent) — otherwise
    // probeWikiSource's base-drift check assumes the nested-private shape and
    // fails looking for a separate `wiki/` git repo that was never created.
    await mkdir(join(tempDir, 'wiki'), { recursive: true });
    await writeFile(join(tempDir, 'wiki', '.gitkeep'), '');
    execFileSync('git', ['add', '-A'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('admits a well-formed explore_code handoff (no write_scope, web:false)', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir }).toString().trim();
    const result = await checkAdmission(makeHandoff({ base_sha: head }), tempDir);
    expect(result.ok).toBe(true);
  });

  it('refuses an explore_code handoff that declares a non-empty write_scope', async () => {
    const result = await checkAdmission(makeHandoff({ write_scope: ['src/'] }), tempDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ENVELOPE_EXCEEDS_MODE');
    expect(result.message).toContain('write_scope');
  });

  it('refuses an explore_code handoff that requests web:true', async () => {
    const result = await checkAdmission(makeHandoff({ web: true }), tempDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ENVELOPE_EXCEEDS_MODE');
    expect(result.message).toContain('web:true');
  });
});

// ---------------------------------------------------------------------------
// capture.ts — explore_code verdict ladder (mirrors research exactly)
// ---------------------------------------------------------------------------

describe('capture.ts — explore_code verdict ladder (WK-0183, mirrors research)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-explore-code-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('explore_code mode + a clean piResult -> outcome: delivered (the transcript is the product, not a file)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'explore_code' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      piResult: { outcome: 'completed', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: 100, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
  });

  it('explore_code mode + a failed piResult -> outcome: failed, reason: process_error (crash detection, never a verdict read from prose)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'explore_code' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      piResult: { outcome: 'failed', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: 50, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: process_error');
  });

  it('explore_code mode + no piResult + empty accumulatedText -> outcome: failed, reason: empty_transcript (WK-0187 backstop)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'explore_code' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({ runDir, handoff, delivery, accumulatedText: '   ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: empty_transcript');
  });
});

// ---------------------------------------------------------------------------
// recovery-block.ts — explorer role (WK-0183, HO-0064 F1 critical finding:
// the isFindingsRole OR-chain must include explorer or every valid explorer
// recovery block fails findings-role validation).
// ---------------------------------------------------------------------------

describe('recovery-block.ts — explorer role (WK-0183)', () => {
  const VALID_EXPLORER_NO_FINDINGS_PAYLOAD = {
    schema_version: KB_DISPATCH_RECOVERY_VERSION,
    reported_role: 'explorer',
    reported_subject: 'HO-0002',
    reported_outcome: 'no_findings',
    summary: 'Explored the auth module; nothing noteworthy.',
    findings: [],
    finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    reviewed_controls: [],
  };

  const VALID_EXPLORER_CHANGES_REQUESTED_PAYLOAD = {
    schema_version: KB_DISPATCH_RECOVERY_VERSION,
    reported_role: 'explorer',
    reported_subject: 'HO-0002',
    reported_outcome: 'changes_requested',
    summary: 'Found a structural issue worth flagging.',
    findings: [
      {
        id: 'F1',
        title: 'Auth module mixes concerns',
        severity: 'medium',
        blocking: false,
        affected_paths: [{ path: 'src/auth.ts', line: 10 }],
        control_id: null,
      },
    ],
    finding_counts: { total: 1, blocking: 0, critical: 0, high: 0, medium: 1, low: 0, info: 0 },
    reviewed_controls: [],
  };

  it('accepts reported_role: "explorer" with outcome no_findings as valid', () => {
    const evidence = validateRecoveryPayload(VALID_EXPLORER_NO_FINDINGS_PAYLOAD);
    expect(evidence.valid).toBe(true);
    expect(evidence.diagnostics).toEqual([]);
    expect(evidence.result?.reported_role).toBe('explorer');
    expect(evidence.result?.reported_outcome).toBe('no_findings');
    expect(evidence.authority).toBe('child_evidence_only');
  });

  it('accepts reported_role: "explorer" with the findings-outcome vocabulary (changes_requested + a finding)', () => {
    const evidence = validateRecoveryPayload(VALID_EXPLORER_CHANGES_REQUESTED_PAYLOAD);
    expect(evidence.valid).toBe(true);
    expect(evidence.diagnostics).toEqual([]);
    expect(evidence.result?.reported_role).toBe('explorer');
    expect(evidence.result?.reported_outcome).toBe('changes_requested');
    expect(evidence.result?.findings.length).toBe(1);
  });

  it('rejects an explorer payload that uses a worker outcome instead of a findings outcome (role_outcome_mismatch — proves the isFindingsRole OR-chain actually routes explorer)', () => {
    const evidence = validateRecoveryPayload({
      ...VALID_EXPLORER_NO_FINDINGS_PAYLOAD,
      reported_outcome: 'completed',
    });
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.some((d) => d.code === 'role_outcome_mismatch')).toBe(true);
  });

  it('rejects an explorer payload that sets kind (worker-only field)', () => {
    const evidence = validateRecoveryPayload({
      ...VALID_EXPLORER_NO_FINDINGS_PAYLOAD,
      kind: 'scope_insufficient',
    });
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.some((d) => d.code === 'kind_not_allowed_for_role')).toBe(true);
  });
});
