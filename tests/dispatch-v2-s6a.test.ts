/**
 * PLN-0004 S6a / Session C S6a.1 — tests for the `kb-dispatch-recovery.v1`
 * terminal-block recovery signal, mode-specific prompt framings, base_ref-aware
 * admission, fixup_context frontmatter, and response-doc rendering
 * (execution/s6-rulings.md, execution/mid_project_review_rulings.md ruling 1).
 *
 * Covers:
 *  - recovery-block.ts: `extractRecoveryBlock` (terminal fenced-block scan)
 *    and `validateRecoveryPayload` (S6a.1 ruling 1) — the deterministic
 *    parse-or-fail contract that replaced response-header.ts's
 *    `parseReviewFile` and the bespoke `.dispatch-out/review.yaml` file
 *    channel (both deleted; response-header.ts no longer exists).
 *  - assemble.ts: mode-specific framings for all four §6 modes, plus fix-up
 *    context injection (coordination context only — grants no authority),
 *    and the recovery-block prompt contract worker/reviewer/redteam see.
 *  - admission.ts: baseSha now resolves from `handoff.base_ref` when
 *    declared, instead of unconditionally using HEAD.
 *  - ho.ts: the new optional `fixup_context` frontmatter field.
 *  - capture.ts: the `## Recovery Signal` response-doc section and the V4
 *    note 3 role asymmetry in `deriveVerdict` (implement: diagnostic
 *    evidence only; code_review/redteam: the block IS the deliverable).
 *
 * No personal/absolute paths appear in fixtures (WK-0043 rule); all
 * filesystem tests use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractRecoveryBlock,
  validateRecoveryPayload,
  KB_DISPATCH_RECOVERY_VERSION,
  parseHandoffContent,
  assemblePrompt,
  checkAdmission,
  writeResponseDoc,
  parsePiOutput,
  type Handoff,
  type DeliveryOutcome,
  type RecoveryBlockEvidence,
} from '@kb/dispatch-core';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// recovery-block.ts — extractRecoveryBlock / validateRecoveryPayload (S6a.1,
// mid_project_review_rulings.md ruling 1). Fixtures below are raw LLM output
// text (for extractRecoveryBlock) or already-parsed JSON payload objects
// (for validateRecoveryPayload) — never `.dispatch-out/review.yaml` content,
// which no longer exists (response-header.ts and the file-artifact channel
// it parsed are both deleted).
// ---------------------------------------------------------------------------

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

const VALID_REVIEWER_PAYLOAD = {
  schema_version: KB_DISPATCH_RECOVERY_VERSION,
  reported_role: 'reviewer',
  reported_subject: 'HO-0042',
  reported_outcome: 'changes_requested',
  summary: 'Found issues',
  findings: [
    {
      id: 'F1',
      title: 'Bug',
      severity: 'high',
      blocking: true,
      affected_paths: [{ path: 'src/foo.ts', line: 42 }],
      control_id: null,
    },
  ],
  finding_counts: { total: 1, blocking: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  reviewed_controls: [{ control_id: 'AC-1', result: 'fail' }],
};

/** Builds a fenced code block: ```<info>\n<body>\n``` */
function fenceBlock(info: string, body: string): string {
  return ['```' + info, body, '```'].join('\n');
}

/** Builds a `kb-dispatch-recovery.v1`-marked fence around a JSON-serialized payload. */
function recoveryFence(payload: unknown, info: string = KB_DISPATCH_RECOVERY_VERSION): string {
  return fenceBlock(info, JSON.stringify(payload, null, 2));
}

describe('recovery-block.ts — extractRecoveryBlock (S6a.1, ruling 1)', () => {
  it('extracts and validates a well-formed terminal block (happy path, worker)', () => {
    const text = `Some narrative text.\n\n${recoveryFence(VALID_WORKER_PAYLOAD)}`;
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(true);
    expect(evidence.diagnostics).toEqual([]);
    expect(evidence.result?.reported_role).toBe('worker');
    expect(evidence.result?.reported_outcome).toBe('completed');
    expect(evidence.authority).toBe('child_evidence_only');
  });

  it('extracts and validates a well-formed terminal block (happy path, reviewer with findings)', () => {
    const text = `Here is my review.\n\n${recoveryFence(VALID_REVIEWER_PAYLOAD)}`;
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.reported_role).toBe('reviewer');
    expect(evidence.result?.findings).toHaveLength(1);
  });

  it('returns missing_result when the output has no fenced block at all', () => {
    const text = 'I looked at the diff and everything seems fine. No code block here.';
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('missing_result');
  });

  it('returns malformed_json when the fenced block body is not valid JSON', () => {
    const text = fenceBlock(KB_DISPATCH_RECOVERY_VERSION, 'this is not valid json at all');
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('malformed_json');
  });

  it('returns multiple_json_candidates when more than one JSON-shaped block is present', () => {
    const text = [
      'Here is an example of the format:',
      '',
      fenceBlock('json', JSON.stringify({ foo: 'bar' })),
      '',
      recoveryFence(VALID_WORKER_PAYLOAD),
    ].join('\n');
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('multiple_json_candidates');
  });

  it('returns trailing_prose_after_result when prose follows the block', () => {
    const text = `${recoveryFence(VALID_WORKER_PAYLOAD)}\n\nThanks for reviewing!`;
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('trailing_prose_after_result');
  });

  it('returns ordinary_json_code_block for a plain ```json fence missing the marker', () => {
    const text = fenceBlock('json', JSON.stringify(VALID_WORKER_PAYLOAD, null, 2));
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('ordinary_json_code_block');
  });

  it('is invalid when the block is not the terminal content (narration continues after it)', () => {
    const text = [
      recoveryFence(VALID_WORKER_PAYLOAD),
      '',
      'Let me also double check the test suite before I finish.',
    ].join('\n');
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recovery-block.ts — extractRecoveryBlock: bare JSON auto-detect (WK-0130).
// Constrained decoding (WK-0125) makes the CLI emit bare JSON with no fence
// at all; the fence-only extractor above reported `missing_result` on every
// such run. `extractRecoveryBlock` now tries the whole-trimmed-text-is-one-
// JSON-object shape FIRST (mirroring agent-chassis's
// `extractTerminalJsonCandidate` / `extractWholeRawJsonCandidate`,
// `agent-role-result.mjs:496`/`566-572`), only falling through to the
// existing fence scan (describe block above, unchanged) when that shape
// check fails. `RecoveryBlockEvidence.extractionKind` records which path
// supplied the candidate (`raw_json` vs `marked_fence`).
// ---------------------------------------------------------------------------

describe('recovery-block.ts — extractRecoveryBlock: bare JSON auto-detect (WK-0130)', () => {
  it('accepts bare JSON when the whole trimmed output is exactly one recovery block object (constrained decoding shape)', () => {
    const text = `\n${JSON.stringify(VALID_WORKER_PAYLOAD, null, 2)}\n`;
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(true);
    expect(evidence.diagnostics).toEqual([]);
    expect(evidence.result?.reported_role).toBe('worker');
    expect(evidence.extractionKind).toBe('raw_json');
  });

  it('records extractionKind: marked_fence for the existing fenced happy path (no regression)', () => {
    const text = `Some narrative text.\n\n${recoveryFence(VALID_WORKER_PAYLOAD)}`;
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(true);
    expect(evidence.extractionKind).toBe('marked_fence');
  });

  it('falls through to the fence scan when prose precedes a fenced block, still finding it (mixed input, no raw_json regression)', () => {
    const text = [
      'Let me think about this change carefully.',
      'I will check every affected file before reporting.',
      '',
      recoveryFence(VALID_REVIEWER_PAYLOAD),
    ].join('\n');
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.reported_role).toBe('reviewer');
    expect(evidence.extractionKind).toBe('marked_fence');
  });

  it('bare JSON that parses but fails schema validation stays on the raw_json path instead of falling back to the fence scan', () => {
    const text = JSON.stringify({ not: 'a valid payload' });
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.extractionKind).toBe('raw_json');
    expect(evidence.diagnostics.map((d) => d.code)).toContain('missing_required_field');
  });

  it('falls through to the fence scan for ordinary prose with no JSON shape at all, yielding missing_result', () => {
    const text = 'I looked at everything and nothing needs fixing. No code block here either.';
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('missing_result');
    expect(evidence.extractionKind).toBeUndefined();
  });

  it('does not accept bare JSON followed by trailing text as raw_json — the whole trimmed output must be the JSON object', () => {
    const text = `${JSON.stringify(VALID_WORKER_PAYLOAD)}\n\nThanks for reviewing!`;
    const evidence = extractRecoveryBlock(text);
    expect(evidence.valid).toBe(false);
    expect(evidence.extractionKind).not.toBe('raw_json');
    expect(evidence.diagnostics.map((d) => d.code)).toContain('missing_result');
  });
});

describe('recovery-block.ts — validateRecoveryPayload (S6a.1, ruling 1)', () => {
  it('accepts a valid worker payload with a kind', () => {
    const payload = { ...VALID_WORKER_PAYLOAD, reported_outcome: 'partial', kind: 'scope_insufficient' };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.kind).toBe('scope_insufficient');
  });

  it('accepts a valid reviewer payload with findings', () => {
    const evidence = validateRecoveryPayload(VALID_REVIEWER_PAYLOAD);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.findings).toHaveLength(1);
  });

  it('rejects a schema_version that does not match kb-dispatch-recovery.v1', () => {
    const payload = { ...VALID_WORKER_PAYLOAD, schema_version: 'kb-dispatch-recovery.v0' };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('schema_mismatch');
  });

  it('rejects a worker payload using a findings outcome instead of a worker outcome', () => {
    const payload = { ...VALID_WORKER_PAYLOAD, reported_outcome: 'no_findings' };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('role_outcome_mismatch');
  });

  it('rejects a reviewer payload using a worker outcome instead of a findings outcome', () => {
    const payload = { ...VALID_REVIEWER_PAYLOAD, reported_outcome: 'completed' };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('role_outcome_mismatch');
  });

  it('rejects finding_counts that do not match the recomputed findings', () => {
    const payload = {
      ...VALID_REVIEWER_PAYLOAD,
      finding_counts: { ...VALID_REVIEWER_PAYLOAD.finding_counts, total: 2 },
    };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('finding_count_mismatch');
  });

  it('rejects a payload carrying a backend authority field', () => {
    const payload = { ...VALID_WORKER_PAYLOAD, run_id: 'RUN-123' };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('authority_field_forbidden');
  });

  it('accepts a worker payload with non-empty findings (ruling 1 item 7 — deliberate divergence from agent-chassis)', () => {
    const payload = {
      ...VALID_WORKER_PAYLOAD,
      findings: [
        {
          id: 'F1',
          title: 'Noticed a pre-existing null check gap',
          severity: 'low',
          blocking: false,
          affected_paths: [],
          control_id: null,
        },
      ],
      finding_counts: { total: 1, blocking: 0, critical: 0, high: 0, medium: 0, low: 1, info: 0 },
    };
    const evidence = validateRecoveryPayload(payload);
    expect(evidence.valid).toBe(true);
    expect(evidence.result?.findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// adapters/pi.ts — lastAssistantText/accumulatedText extraction (WK-0092/
// WK-0093). No longer feeds review-verdict parsing (S6a.1 moved that onto
// the `kb-dispatch-recovery.v1` terminal fenced block extracted by
// recovery-block.ts's `extractRecoveryBlock` — see the `recovery-block.ts —
// extractRecoveryBlock` describe block above) — these fields still exist in
// `PiResult`: accumulatedText remains for whole-transcript narrative/
// debugging, while lastAssistantText is DEC-0010's diagnosis-channel
// source, embedded verbatim as the response doc's `## Worker Report`
// section (capture.ts) — see tests/dispatch-v2-foundation.test.ts's golden
// fixture describe block for that proof. Kept here as regression coverage
// for the extraction mechanics themselves, independent of what consumes
// them.
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — lastAssistantText/accumulatedText extraction', () => {
  // Six narration lines with no blank lines, deliberately pushing the final
  // turn's content to line 7 of the whole-session text — this is the exact
  // bug reproduced: an agentic reviewer narrates and calls tools before
  // producing its final-turn content.
  const NARRATION = [
    'Let me look at the diff first.',
    'I will check each changed file for correctness.',
    'Then I will run the test suite.',
    'Now checking edge cases.',
    'Verifying acceptance criteria next.',
    'Finally, composing the review verdict.',
  ].join('\n') + '\n';

  // Arbitrary final-turn text — proves the extraction boundary between
  // narration and the final turn. No longer tied to any particular response
  // schema: response-header.ts's YAML header is deleted, and parsePiOutput's
  // extraction is agnostic to what the final turn contains.
  const FINAL_TURN_TEXT = 'Review complete: no blocking issues found.\n';

  function codeReviewStreamLines(): string {
    return [
      JSON.stringify({ type: 'agent_start' }),
      // Turn 1: narration text + a tool call (e.g. reading the diff), its
      // own message_end — this is what a real agentic code_review run does
      // before it ever produces its final-turn content. (WK-0092/WK-0093:
      // text rides on the message_end's content array, not a top-level
      // text_delta event — Pi never emits one.)
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: NARRATION },
            { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'git diff' } },
          ],
          usage: { totalTokens: 40, cost: { total: 0.0004 } },
        },
      }),
      JSON.stringify({ type: 'turn_end', stopReason: 'tool_calls' }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'diff --git a/foo b/foo' }],
          isError: false,
        },
      }),
      // Turn 2: the final reply — the final-turn content lives here, and
      // ONLY here.
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: FINAL_TURN_TEXT }],
          usage: { totalTokens: 15, cost: { total: 0.0001 } },
        },
      }),
      JSON.stringify({ type: 'turn_end', stopReason: 'end_turn' }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');
  }

  it('parsePiOutput separates lastAssistantText (final turn only) from accumulatedText (whole session)', () => {
    const result = parsePiOutput(codeReviewStreamLines());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.accumulatedText).toBe(NARRATION + FINAL_TURN_TEXT);
    expect(result.data.lastAssistantText).toBe(FINAL_TURN_TEXT);
    expect(result.data.usage.totalTokens).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// assemble.ts — mode-specific framings (S6a)
// ---------------------------------------------------------------------------

type Mode = 'implement' | 'code_review' | 'redteam' | 'research';

function hoMarkdownForMode(mode: Mode, fixupContext?: string): string {
  const fixupLine = fixupContext ? `fixup_context: "${fixupContext}"\n` : '';
  return `---
id: HO-TEST
title: Test task
mode: ${mode}
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: Works"
validation:
  - "npm test"
status: draft
${fixupLine}---

The task body text.
`;
}

describe('assemble.ts — mode-specific framings (S6a)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await createTempDir('kb-assemble-s6a-');
    await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function assembleForMode(mode: Mode, fixupContext?: string) {
    const content = hoMarkdownForMode(mode, fixupContext);
    await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-TEST.md'), content, 'utf8');
    const parsed = parseHandoffContent(content, 'HO-TEST.md');
    if (!parsed.ok) throw new Error(`fixture HO markdown failed to parse: ${parsed.message}`);
    return assemblePrompt(parsed.data, repoRoot);
  }

  it('implement framing includes write scope, acceptance criteria, and validation', async () => {
    const result = await assembleForMode('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).toContain('Write Scope');
    expect(result.data.text).toContain('Acceptance Criteria');
    expect(result.data.text).toContain('Validation');
  });

  it('implement framing includes the pre-existing-bug escalation boundary', async () => {
    const result = await assembleForMode('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('pre-existing bug');
  });

  it('implement framing includes environment discipline', async () => {
    const result = await assembleForMode('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('Do not create, modify, or install new environments');
  });

  it('code_review framing excludes write scope and validation but includes acceptance criteria', async () => {
    const result = await assembleForMode('code_review');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).not.toContain('Write Scope');
    expect(result.data.text).not.toContain('Validation');
    expect(result.data.text).toContain('Acceptance Criteria');
  });

  it('code_review framing includes the structured response format', async () => {
    const result = await assembleForMode('code_review');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('kb-dispatch-recovery.v1');
    // DEC-0037: prose review is the deliverable; the recovery block is optional metadata.
    expect(result.data.text).toContain('Your prose review above is the primary deliverable');
    expect(result.data.text).not.toContain('This block IS your deliverable');
    expect(result.data.text).not.toContain('the run is marked `failed`');
  });

  it('code_review framing includes the tsc --build --noEmit sandbox guidance', async () => {
    const result = await assembleForMode('code_review');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('tsc --build --noEmit');
  });

  it('code_review framing includes fix-up flagging', async () => {
    const result = await assembleForMode('code_review');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('iterative fix-up patterns');
  });

  it('redteam framing excludes write scope, acceptance criteria, and validation', async () => {
    const result = await assembleForMode('redteam');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).not.toContain('Write Scope');
    expect(result.data.text).not.toContain('Acceptance Criteria');
    expect(result.data.text).not.toContain('Validation');
  });

  it('redteam framing includes the fail-closed bwrap instruction', async () => {
    const result = await assembleForMode('redteam');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).toContain('bwrap');
    expect(result.data.text).toContain('stop and state in your final message that you need a bwrap sandbox environment');
  });

  it('redteam framing broadens the focus surface beyond security (WK-0145)', async () => {
    const result = await assembleForMode('redteam');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Full adversarial surface, not just "security holes" (WK-0145 R1).
    expect(result.data.text).toContain('spec gaps');
    expect(result.data.text).toContain('over-engineering');
    expect(result.data.text).toContain('connectedness');
  });

  it('research framing casts the worker as a research investigator', async () => {
    const result = await assembleForMode('research');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('research investigator');
  });

  it('research mode includes the optional recovery block instruction (WK-0145 R2)', async () => {
    const result = await assembleForMode('research');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).toContain('kb-dispatch-recovery.v1');
    expect(result.data.text).toContain('"reported_role": "researcher"');
    // WK-0143's optional-metadata framing: prose is primary, block is opportunistic.
    expect(result.data.text).toContain('Your prose review above is the primary deliverable');
    expect(result.data.text).not.toContain('This block IS your deliverable');
  });

  it('injects fix-up context when the handoff declares it', async () => {
    const result = await assembleForMode('implement', 'Prior review flagged a null-check gap in the parser.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.text).toContain('Prior Review Findings (coordination context only)');
    expect(result.data.text).toContain('Prior review flagged a null-check gap in the parser.');
  });

  it('omits fix-up context when the handoff does not declare it', async () => {
    const result = await assembleForMode('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).not.toContain('Prior Review Findings');
  });
});

// ---------------------------------------------------------------------------
// admission.ts — base_ref-aware baseSha resolution (S6a)
// ---------------------------------------------------------------------------

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-TEST',
    title: 'Test task for base_ref resolution',
    mode: 'implement',
    write_scope: ['src/'],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['true'],
    status: 'draft',
    // WK-0116: resolves via the wiki/issues + wiki/initiatives fixtures written in beforeEach.
    work_item: 'WK-9002',
    ...overrides,
  };
}

describe('admission.ts — base_ref-aware baseSha resolution (S6a)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await createTempDir('kb-admission-s6a-');
    execFileSync('git', ['init'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), 'test repo\n', 'utf8');
    // WK-0116: makeHandoff()'s default work_item must resolve to a real initiative
    // for these full-admission-success tests to reach baseSha resolution.
    await mkdir(join(repoRoot, 'wiki', 'issues'), { recursive: true });
    await writeFile(
      join(repoRoot, 'wiki', 'issues', 'WK-9002.md'),
      '---\nid: "WK-9002"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9002\n---\n\n# WK-9002: Fixture\n',
      'utf8',
    );
    await mkdir(join(repoRoot, 'wiki', 'initiatives'), { recursive: true });
    await writeFile(
      join(repoRoot, 'wiki', 'initiatives', 'IN-9002.md'),
      '---\nid: "IN-9002"\ntitle: "Fixture initiative"\nstatus: todo\n---\n\n# IN-9002: Fixture\n',
      'utf8',
    );
    execFileSync('git', ['add', '-A'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('resolves baseSha to HEAD when base_ref is null', async () => {
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();

    const result = await checkAdmission(makeHandoff({ base_ref: null }), repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.baseSha).toBe(expectedSha);
  });

  it("resolves baseSha to the declared base_ref's SHA, not current HEAD", async () => {
    const branchSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
    execFileSync('git', ['branch', 'dispatch/HO-TEST'], { cwd: repoRoot });

    // Advance HEAD past the branch so a correct implementation is forced to
    // diverge from "just use HEAD" to satisfy this assertion.
    await writeFile(join(repoRoot, 'second.md'), 'second commit content\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'second commit'], { cwd: repoRoot });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
    expect(headSha).not.toBe(branchSha);

    const result = await checkAdmission(makeHandoff({ base_ref: 'dispatch/HO-TEST' }), repoRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.baseSha).toBe(branchSha);
    expect(result.data.baseSha).not.toBe(headSha);
  });
});

// ---------------------------------------------------------------------------
// ho.ts — fixup_context frontmatter (S6a)
// ---------------------------------------------------------------------------

describe('ho.ts — fixup_context frontmatter (S6a)', () => {
  it('parses fixup_context when present in frontmatter', () => {
    const content = `---
id: HO-TEST
title: Test task
mode: implement
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
fixup_context: "Prior review flagged a null-check gap in the parser."
acceptance:
  - "AC-1: Works"
validation:
  - "npm test"
status: draft
---

Body text.
`;
    const result = parseHandoffContent(content, 'HO-TEST.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fixup_context).toBe('Prior review flagged a null-check gap in the parser.');
  });

  it('leaves fixup_context undefined when absent from frontmatter', () => {
    const content = `---
id: HO-TEST
title: Test task
mode: implement
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: Works"
validation:
  - "npm test"
status: draft
---

Body text.
`;
    const result = parseHandoffContent(content, 'HO-TEST.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fixup_context).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// capture.ts — Recovery Signal section rendering (S6a.1). Replaces the
// deleted reviewResult/reviewParseError fields (response-header.ts's
// StructuredReviewResult) with recoveryEvidence: RecoveryBlockEvidence.
//
// The verdict-ladder assertions below (outcome/reason/delivery_method) cover
// DEC-0037 (WK-0125): code_review/redteam no longer hard-fail on an invalid
// block (reverses DEC-0023 V4 note 3 for advisory modes) — they fall back to
// prose (`delivered`, `delivery_method: prose_fallback`) instead.
// ---------------------------------------------------------------------------

describe('capture.ts — Recovery Signal section rendering (S6a.1)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-s6a-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'code_review' };
  const delivery: DeliveryOutcome = { status: 'no_changes' };

  it('includes a ## Recovery Signal section when recoveryEvidence is valid', async () => {
    const recoveryEvidence: RecoveryBlockEvidence = validateRecoveryPayload(VALID_REVIEWER_PAYLOAD);
    expect(recoveryEvidence.valid).toBe(true); // sanity: fixture itself must validate

    const result = await writeResponseDoc({ runDir, handoff, delivery, recoveryEvidence });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('## Recovery Signal');
    expect(written).toContain('**Reported outcome:** changes_requested');
    expect(written).toContain('### Findings');
    expect(written).toContain('Bug');
  });

  it('omits the Recovery Signal section when recoveryEvidence is absent', async () => {
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).not.toContain('Recovery Signal');
  });

  it('renders a parse-failure notice when recoveryEvidence is invalid', async () => {
    const recoveryEvidence: RecoveryBlockEvidence = validateRecoveryPayload({ not: 'a valid payload' });
    expect(recoveryEvidence.valid).toBe(false); // sanity: fixture itself must fail validation

    const result = await writeResponseDoc({ runDir, handoff, delivery, recoveryEvidence });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('## Recovery Signal');
    expect(written).toContain('**Parse failed:**');
    expect(written).toContain('schema_version is required');
  });

  it('code_review with invalid evidence -> outcome: delivered, reason/delivery_method: prose_fallback (DEC-0037 reverses DEC-0023 V4 note 3: the block is opportunistic, not the deliverable — a malformed block falls back to prose instead of hard-failing the run)', async () => {
    const recoveryEvidence: RecoveryBlockEvidence = validateRecoveryPayload({ not: 'a valid payload' });

    const result = await writeResponseDoc({ runDir, handoff, delivery, recoveryEvidence });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).toContain('reason: prose_fallback');
    expect(written).toContain('delivery_method: prose_fallback');
    expect(written).not.toContain('outcome: failed');
    expect(written).not.toContain('missing_review_artifact');
  });

  it('code_review with absent evidence -> outcome: delivered, reason/delivery_method: prose_fallback (same fallback: no block at all is treated the same as an invalid one)', async () => {
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).toContain('reason: prose_fallback');
    expect(written).toContain('delivery_method: prose_fallback');
  });

  it('code_review with valid evidence -> outcome: delivered, delivery_method: structured, no reason (the opportunistic shortcut — unchanged by DEC-0037)', async () => {
    const recoveryEvidence: RecoveryBlockEvidence = validateRecoveryPayload(VALID_REVIEWER_PAYLOAD);
    expect(recoveryEvidence.valid).toBe(true); // sanity: fixture itself must validate

    const result = await writeResponseDoc({ runDir, handoff, delivery, recoveryEvidence });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).toContain('delivery_method: structured');
    expect(written).not.toContain('reason:');
  });
});

// ---------------------------------------------------------------------------
// capture.ts — mechanical verdict ladder (DEC-0010 rule 2 / WK-0095). The
// outcome.yaml channel above is deleted outright, not re-scoped:
// `deriveVerdict` (module-private in capture.ts) computes the response-doc
// outcome exclusively from delivery-gate facts, per-mode deliverable checks,
// and (for code_review/redteam only) `recoveryEvidence.valid` — never the
// worker's chat text, never a worker-authored self-report file. DEC-0037
// (WK-0125) reverses DEC-0023 V4 note 3 for these two advisory modes: the
// block is opportunistic (drives `delivery_method: structured` when valid),
// falling back to prose (`delivered`, `delivery_method: prose_fallback`)
// rather than hard-failing when absent/invalid — see the redteam-specific
// tests below for the crash-detection-still-dominates case. Exercised here
// through `writeResponseDoc`'s public surface (the response doc's
// `outcome`/`reason`/`delivery_method` frontmatter), the same approach the
// Recovery Signal tests above use for recoveryEvidence.
// ---------------------------------------------------------------------------

describe('capture.ts — mechanical verdict ladder (DEC-0010 / WK-0095)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-verdict-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('implement mode + delivered diff -> outcome: delivered, no reason', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = {
      status: 'delivered',
      branch: 'dispatch/HO-TEST',
      commitSha: 'abc123',
      changedFiles: ['src/foo.ts'],
    };
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).not.toContain('reason:');
  });

  it('implement mode + no_delta delivery -> outcome: failed, reason: no_deliverable (DEC-0010: silence plus no deliverable is failure, never success)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_delta' };
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: no_deliverable');
  });

  it('implement mode + no_changes delivery -> outcome: delivered (idempotent redelivery: the exact same tree is already on the branch from the same base)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).not.toContain('reason:');
  });

  it('implement mode + refused_out_of_scope delivery -> outcome: refused, reason carries the delivery status', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = {
      status: 'refused_out_of_scope',
      offendingPaths: ['other/file.ts'],
      quarantinePath: '/tmp/quarantine.diff',
    };
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: refused');
    expect(written).toContain('reason: refused_out_of_scope');
  });

  it('implement mode + secret_in_diff delivery -> outcome: refused (delivery-gate refusal still wins over everything)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = {
      status: 'secret_in_diff',
      patterns: ['sk-live-redacted'],
      quarantinePath: '/tmp/quarantine.diff',
    };
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: refused');
    expect(written).toContain('reason: secret_in_diff');
  });

  it("code_review mode + no_changes delivery + a valid recovery block -> outcome: delivered, delivery_method: structured (the advisory path's normal shape: reviewers land no diff, and a valid block drives mechanical merge gating)", async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'code_review' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const recoveryEvidence = validateRecoveryPayload(VALID_REVIEWER_PAYLOAD);
    const result = await writeResponseDoc({ runDir, handoff, delivery, recoveryEvidence });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).toContain('delivery_method: structured');
  });

  it('redteam mode + no_changes delivery + an invalid recovery block + a completed process -> outcome: delivered, delivery_method: prose_fallback (DEC-0037: a malformed block from an otherwise-successful run falls back to prose, not a hard fail)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'redteam' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const recoveryEvidence = validateRecoveryPayload({ not: 'a valid payload' });
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      recoveryEvidence,
      piResult: { outcome: 'completed', usage: { totalTokens: 50, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
    expect(written).toContain('reason: prose_fallback');
    expect(written).toContain('delivery_method: prose_fallback');
  });

  it('redteam mode + a crashed process + an invalid recovery block -> outcome: failed, reason: process_error (crash detection stays dominant over the DEC-0037 prose fallback — a crashed process has no real deliverable, block validity notwithstanding)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'redteam' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const recoveryEvidence = validateRecoveryPayload({ not: 'a valid payload' });
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      recoveryEvidence,
      piResult: { outcome: 'error', usage: { totalTokens: 10, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: process_error');
    expect(written).not.toContain('prose_fallback');
    expect(written).not.toContain('delivery_method');
  });

  it('redteam mode + a crashed process + a VALID recovery block -> outcome: failed, reason: process_error (a crashed process cannot be resurrected to delivered by a late-arriving well-formed block — DEC-0010: no worker-authored content can manufacture a success verdict)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'redteam' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const recoveryEvidence = validateRecoveryPayload(VALID_REVIEWER_PAYLOAD);
    expect(recoveryEvidence.valid).toBe(true); // sanity: fixture itself must validate
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      recoveryEvidence,
      piResult: { outcome: 'failed', usage: { totalTokens: 10, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: process_error');
    expect(written).not.toContain('outcome: delivered');
  });

  it('research mode + a clean piResult -> outcome: delivered (the transcript is the product, not a file)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'research' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      piResult: { outcome: 'completed', usage: { totalTokens: 100, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: delivered');
  });

  it('research mode + a failed piResult -> outcome: failed, reason: process_error (crash detection, never a verdict read from prose)', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'research' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      piResult: { outcome: 'failed', usage: { totalTokens: 50, costUsd: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: process_error');
  });
});

// ---------------------------------------------------------------------------
// capture.ts — Worker Report embedding (DEC-0010 diagnosis channel / WK-0095).
// The worker's final assistant message is embedded VERBATIM as evidence —
// never parsed, never consulted by deriveVerdict above — under every mode
// and every verdict, so a stopped/blocked/crashed run's diagnosis is always
// readable from the artifact itself.
// ---------------------------------------------------------------------------

describe('capture.ts — Worker Report embedding (DEC-0010 / WK-0095)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-workerreport-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('embeds lastAssistantText verbatim under ## Worker Report', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const message = 'I stopped because the database credential was missing from profiles.json.';
    const result = await writeResponseDoc({ runDir, handoff, delivery, lastAssistantText: message });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('## Worker Report (evidence, not verdict)');
    expect(written).toContain(message);
  });

  it('renders the placeholder when lastAssistantText is absent', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('## Worker Report (evidence, not verdict)');
    expect(written).toContain('(no final message captured)');
  });

  it('renders the placeholder when lastAssistantText is an empty string', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_changes' };
    const result = await writeResponseDoc({ runDir, handoff, delivery, lastAssistantText: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('(no final message captured)');
  });

  const modesAndDeliveries: Array<{ mode: string; delivery: DeliveryOutcome }> = [
    { mode: 'implement', delivery: { status: 'delivered', branch: 'dispatch/HO-TEST', commitSha: 'abc123', changedFiles: ['src/foo.ts'] } },
    { mode: 'implement', delivery: { status: 'no_changes' } },
    { mode: 'code_review', delivery: { status: 'no_changes' } },
    { mode: 'redteam', delivery: { status: 'no_changes' } },
    { mode: 'research', delivery: { status: 'no_changes' } },
  ];

  for (const { mode, delivery } of modesAndDeliveries) {
    it(`appears for mode=${mode}, delivery=${delivery.status} regardless of verdict`, async () => {
      const handoff = { id: 'HO-TEST', title: 'Test task', mode };
      const result = await writeResponseDoc({ runDir, handoff, delivery, lastAssistantText: 'final words from the worker' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = await readFile(result.data.responsePath, 'utf8');
      expect(written).toContain('## Worker Report (evidence, not verdict)');
      expect(written).toContain('final words from the worker');
    });
  }
});

// ---------------------------------------------------------------------------
// capture.ts — no worker-to-success path (DEC-0010 structural acceptance
// criterion / WK-0095): "no code path exists from worker-authored content to
// a success verdict." A fabricated success claim, in EITHER the process
// classification or the chat transcript, must not move an implement run
// with no deliverable off of `failed`.
// ---------------------------------------------------------------------------

describe('capture.ts — no worker-to-success path (DEC-0010 structural acceptance criterion)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-no-worker-success-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('a fabricated piResult.outcome of "completed" plus a triumphant final message cannot upgrade an implement no_delta delivery to delivered', async () => {
    const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
    const delivery: DeliveryOutcome = { status: 'no_delta' };
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      // The worker's own process/chat signal claims total success; the
      // verdict ladder must never read piResult.outcome for implement mode
      // at all — only the delivery-gate fact (no_delta = no deliverable;
      // no_changes is reserved for an idempotent redelivery and is NOT this
      // case — see the verdict-ladder tests above).
      piResult: { outcome: 'completed', usage: { totalTokens: 999, costUsd: 0 } },
      lastAssistantText: 'Task completed successfully! Everything is done.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('outcome: failed');
    expect(written).toContain('reason: no_deliverable');
    expect(written).not.toContain('outcome: delivered');
  });
});

// ---------------------------------------------------------------------------
// Golden fixture evidence (WK-0095 checklist): real captures of the DELETED
// outcome.yaml channel's behavior, proving what the old system actually did
// — WK-0091's false-positive `completed` on a run with no real deliverable,
// and the blocked-outcome self-report channel it replaced. These are not
// tests of current code (capture.ts no longer reads either file) — they are
// DEC-0009 evidence that the deleted machinery, and the bug that justified
// deleting it, were both real.
// ---------------------------------------------------------------------------

describe('golden fixture evidence — old outcome.yaml channel behavior (WK-0095)', () => {
  it("RUN-dcb2072e capture: the old system's false-positive outcome: completed on a run with no real deliverable", async () => {
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'RUN-dcb2072e-false-positive', 'HO-0009.response.md');
    const content = await readFile(fixturePath, 'utf8');
    expect(content).toContain('outcome: completed');
  });

  it("RUN-a4444bdc capture: the old outcome.yaml self-report channel's outcome: blocked", async () => {
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'RUN-a4444bdc-blocked-outcome', 'HO-0009.response.md');
    const content = await readFile(fixturePath, 'utf8');
    expect(content).toContain('outcome: blocked');
  });
});
