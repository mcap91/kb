/**
 * WK-0251 — the `report` field on the `kb-dispatch-recovery.v1` block
 * (overseer-amended ruling, Resolutions row 1). DEC-0037 constrained
 * decoding forces claude/codex implement final messages to be schema-only
 * JSON (pipeline.ts's `--json-schema`/`--output-schema`), so the
 * human-readable report the HO's Expected Output asks for had nowhere to
 * live and was lost — `capture.ts` rendered the raw JSON as `## Worker
 * Report`. The ruled fix: `report` (markdown string) is REQUIRED in
 * `contract/kb-dispatch-recovery.v1.schema.json` (the schema file handed to
 * claude/codex implement runs only); OPTIONAL+nullable in
 * `recovery-block.ts`'s validator for every role/family, so reviewer/
 * redteam/explorer/researcher/pi blocks — which never see that schema file
 * — stay valid without it; and `capture.ts` renders a valid block's
 * non-empty `report` as `## Worker Report`, falling back to
 * `lastAssistantText` verbatim exactly as before when `report` is
 * absent/empty (pi implement, and every non-implement role).
 *
 * Covers three surfaces:
 *  - the schema file: `report` is required and non-nullable there.
 *  - recovery-block.ts: `report` optional+nullable in the validator —
 *    present/absent/null are all valid, a non-string is rejected.
 *  - capture.ts: `## Worker Report` prefers `report` over the raw final
 *    message, and `worker_report_chars` is recomputed from the same
 *    resolved text (not the stale raw-message length).
 *
 * Conventions mirror tests/dispatch-v2-s6a.test.ts (`VALID_WORKER_PAYLOAD`,
 * `fenceBlock`/`recoveryFence`, `createTempDir`, `@kb/dispatch-core` import).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { assemblePrompt } from '../packages/dispatch-core/src/assemble.js';
import { parseClaudeOutput } from '../packages/dispatch-core/src/adapters/claude.js';
import { parseHandoffContent } from '../packages/dispatch-core/src/ho.js';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractRecoveryBlock,
  validateRecoveryPayload,
  KB_DISPATCH_RECOVERY_VERSION,
  writeResponseDoc,
  type DeliveryOutcome,
} from '@kb/dispatch-core';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const VALID_WORKER_PAYLOAD = {
  schema_version: KB_DISPATCH_RECOVERY_VERSION,
  reported_role: 'worker',
  reported_subject: 'HO-0042',
  reported_outcome: 'completed',
  summary: 'Implemented the feature',
  findings: [],
  finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  reviewed_controls: [],
};

/** Builds a fenced code block: ```<info>\n<body>\n``` */
function fenceBlock(info: string, body: string): string {
  return ['```' + info, body, '```'].join('\n');
}

/** Builds a `kb-dispatch-recovery.v1`-marked fence around a JSON-serialized payload. */
function recoveryFence(payload: unknown): string {
  return fenceBlock(KB_DISPATCH_RECOVERY_VERSION, JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// contract/kb-dispatch-recovery.v1.schema.json — report required (claude/codex only)
// ---------------------------------------------------------------------------

describe('contract/kb-dispatch-recovery.v1.schema.json — report is required here (WK-0251)', () => {
  function loadSchema(): any {
    const schemaPath = join(process.cwd(), 'contract', 'kb-dispatch-recovery.v1.schema.json');
    return JSON.parse(readFileSync(schemaPath, 'utf8'));
  }

  it('required[] contains report', () => {
    const schema = loadSchema();
    expect(schema.required).toContain('report');
  });

  it('report is a plain (non-nullable) string — unlike summary/kind, claude/codex must actually fill it in', () => {
    const schema = loadSchema();
    expect(schema.properties.report.type).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// recovery-block.ts — report optional+nullable in the validator, every role
// ---------------------------------------------------------------------------

describe('recovery-block.ts — validateRecoveryPayload: report optional+nullable (WK-0251)', () => {
  it('a worker block WITHOUT report is still valid (existing behavior unweakened)', () => {
    const evidence = validateRecoveryPayload(VALID_WORKER_PAYLOAD);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.report).toBeNull();
  });

  it('a worker block with report: null is valid', () => {
    const evidence = validateRecoveryPayload({ ...VALID_WORKER_PAYLOAD, report: null });
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.report).toBeNull();
  });

  it('a worker block with a report string is valid and exposes it verbatim', () => {
    const report = '# Report\n\nDid the thing. Before: `a`. After: `b`.';
    const evidence = validateRecoveryPayload({ ...VALID_WORKER_PAYLOAD, report });
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.report).toBe(report);
  });

  it('a reviewer block without report stays valid (report never binds reviewer/redteam/explorer/researcher — they never see the schema file that requires it)', () => {
    const reviewerPayload = {
      schema_version: KB_DISPATCH_RECOVERY_VERSION,
      reported_role: 'reviewer',
      reported_subject: 'HO-0042',
      reported_outcome: 'no_findings',
      summary: 'Looks good',
      findings: [],
      finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      reviewed_controls: [],
    };
    const evidence = validateRecoveryPayload(reviewerPayload);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.report).toBeNull();
  });

  it('a non-string, non-null report is rejected (invalid_report)', () => {
    const evidence = validateRecoveryPayload({ ...VALID_WORKER_PAYLOAD, report: 42 });
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('invalid_report');
  });
});

// ---------------------------------------------------------------------------
// capture.ts — ## Worker Report renders `report` over the raw final message
// ---------------------------------------------------------------------------

describe("capture.ts — ## Worker Report renders the recovery block's report field (WK-0251)", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-wk0251-capture-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    'a claude/codex-style final message that is ONLY a kb-dispatch-recovery.v1 block with a multi-KB report ' +
      'renders that report as ## Worker Report, not the raw JSON (bites against pre-WK-0251 capture.ts, which ' +
      'rendered lastAssistantText — the raw fenced JSON — verbatim)',
    async () => {
      const filler = Array.from(
        { length: 60 },
        (_, i) => `- validated edge case ${i}: handled correctly, no regression observed.`,
      ).join('\n');
      const reportMarkdown = [
        '# Implementation Report',
        '',
        'Changed `src/foo.ts` to add a null check.',
        '',
        '## Before',
        '```ts',
        'function foo(x) { return x.bar; }',
        '```',
        '',
        '## After',
        '```ts',
        'function foo(x) { return x?.bar ?? null; }',
        '```',
        '',
        '## Test output',
        '```',
        'PASS src/foo.test.ts',
        '```',
        '',
        filler,
      ].join('\n');
      expect(reportMarkdown.length).toBeGreaterThanOrEqual(3000);

      const payload = { ...VALID_WORKER_PAYLOAD, report: reportMarkdown };
      const finalMessage = recoveryFence(payload); // the ENTIRE message is the fenced block — nothing else

      const recoveryEvidence = extractRecoveryBlock(finalMessage);
      expect(recoveryEvidence.valid).toBe(true);
      expect(recoveryEvidence.result?.report).toBe(reportMarkdown);

      const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
      const delivery: DeliveryOutcome = { status: 'no_changes' };
      const result = await writeResponseDoc({
        runDir,
        handoff,
        delivery,
        lastAssistantText: finalMessage,
        recoveryEvidence,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = await readFile(result.data.responsePath, 'utf8');

      expect(written).toContain('## Worker Report (evidence, not verdict)');
      expect(written).toContain(reportMarkdown);
      // Discriminates old vs. new rendering: the raw JSON wrapper (the fence
      // marker line and the `"schema_version"` key/value text) must NOT
      // appear — only the resolved `report` markdown is in the section.
      expect(written).not.toContain('```kb-dispatch-recovery.v1');
      expect(written).not.toContain('"schema_version"');
    },
  );

  it(
    'a pi-style run (prose final message + a trailing block WITHOUT report) still renders the prose via the ' +
      'lastAssistantText fallback — existing behavior unweakened',
    async () => {
      const prose = 'I implemented the greet utility and ran the full test suite; all green.';
      const finalMessage = `${prose}\n\n${recoveryFence(VALID_WORKER_PAYLOAD)}`; // no report field at all

      const recoveryEvidence = extractRecoveryBlock(finalMessage);
      expect(recoveryEvidence.valid).toBe(true);
      expect(recoveryEvidence.result?.report).toBeNull();

      const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
      const delivery: DeliveryOutcome = { status: 'no_changes' };
      const result = await writeResponseDoc({
        runDir,
        handoff,
        delivery,
        lastAssistantText: finalMessage,
        recoveryEvidence,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = await readFile(result.data.responsePath, 'utf8');
      expect(written).toContain(prose);
    },
  );

  it('worker_report_chars counts the rendered report length, not the raw JSON length, when report is present', async () => {
    const reportMarkdown = 'x'.repeat(50);
    const payload = { ...VALID_WORKER_PAYLOAD, report: reportMarkdown };
    const finalMessage = recoveryFence(payload); // the serialized JSON text is far longer than 50 chars

    const recoveryEvidence = extractRecoveryBlock(finalMessage);
    expect(recoveryEvidence.valid).toBe(true);

    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      lastAssistantText: finalMessage,
      recoveryEvidence,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('worker_report_chars: 50');
  });
});

describe('assemble.ts — implement report framing per family (WK-0251)', () => {
  let repoRoot: string;
  const HO = `---
id: HO-9251
title: Report framing fixture
mode: implement
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: works"
validation: ["true"]
status: draft
---

Body.
`;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'kb-report-framing-'));
    await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-9251.md'), HO);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function prompt(family?: 'pi' | 'claude' | 'codex'): Promise<string> {
    const parsed = parseHandoffContent(HO, 'HO-9251.md');
    if (!parsed.ok) throw new Error(parsed.message);
    const result = await assemblePrompt(parsed.data, repoRoot, family === undefined ? {} : { family });
    if (!result.ok) throw new Error(result.message);
    return result.data.text;
  }

  // Why: claude/codex final messages are schema-only JSON; `report` is their only prose channel.
  it.each(['claude', 'codex'] as const)('tells a %s implement worker to put the report in `report`', async (family) => {
    const text = await prompt(family);
    expect(text).toContain('put your full human-readable report in `report`');
    expect(text).toContain('"report":');
  });

  // Why: the ruling keeps pi framing unchanged — pi still shares prose and block in its final message.
  it('leaves the pi (and family-less) implement framing without a report field', async () => {
    for (const text of [await prompt('pi'), await prompt()]) {
      expect(text).not.toContain('`report`');
      expect(text).not.toContain('"report":');
    }
  });
});

// ---------------------------------------------------------------------------
// Live capture — claude -p --json-schema with a multi-KB report (WK-0251
// rule-33 AC). tests/fixtures/claude-p-output-json-schema-report.json is a
// real, unedited `claude -p --output-format json --json-schema "$SCHEMA"`
// capture (2026-11-09, schema = contract/kb-dispatch-recovery.v1.schema.json)
// proving constrained decoding carries a multi-KB markdown `report` intact
// through the adapter and the recovery extractor.
// ---------------------------------------------------------------------------

describe('claude --json-schema live capture — multi-KB report survives end to end (WK-0251)', () => {
  const captureStdout = readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'claude-p-output-json-schema-report.json'),
    'utf8',
  );

  it('parses through the claude adapter: schema-shaped JSON text is the final result', () => {
    const parsed = parseClaudeOutput(captureStdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.outcome).toBe('completed');
    const inner = JSON.parse(parsed.data.lastAssistantText);
    expect(inner.schema_version).toBe(KB_DISPATCH_RECOVERY_VERSION);
  });

  it('extracts as a valid worker block whose report is multi-KB markdown', () => {
    const parsed = parseClaudeOutput(captureStdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const evidence = extractRecoveryBlock(parsed.data.lastAssistantText);
    expect(evidence.valid).toBe(true);
    expect(evidence.diagnostics).toEqual([]);
    expect(evidence.result?.reported_role).toBe('worker');
    expect(evidence.result?.reported_outcome).toBe('completed');
    const report = evidence.result?.report;
    expect(typeof report).toBe('string');
    expect((report as string).length).toBeGreaterThan(4096);
    expect(report).toContain('#');
  });
});
