/**
 * PLN-0004 S6a — tests for structured review header parsing, mode-specific
 * prompt framings, base_ref-aware admission, fixup_context frontmatter, and
 * Structured Review response-doc rendering (execution/s6-rulings.md).
 *
 * Covers:
 *  - response-header.ts: `parseReviewHeader` (ruling 3) — deterministic
 *    parse-or-fail contract for a code_review worker's structured response
 *    header. No fallback path scans free-form prose for authority.
 *  - assemble.ts: mode-specific framings for all four §6 modes, plus fix-up
 *    context injection (coordination context only — grants no authority).
 *  - admission.ts: baseSha now resolves from `handoff.base_ref` when
 *    declared, instead of unconditionally using HEAD.
 *  - ho.ts: the new optional `fixup_context` frontmatter field.
 *  - capture.ts: the `## Structured Review` response-doc section.
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
  parseReviewFile,
  parseHandoffContent,
  assemblePrompt,
  checkAdmission,
  writeResponseDoc,
  parsePiOutput,
  type Handoff,
  type DeliveryOutcome,
  type StructuredReviewResult,
} from '@kb/dispatch-core';
import {
  buildReviewFileReadScript,
  parseReviewFileReadOutput,
  resolveReviewFileOutcome,
} from '../packages/dispatch-core/src/pipeline.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// response-header.ts — parseReviewFile (S6a ruling 3; W4 file-artifact
// re-platform). Fixtures below are raw `.dispatch-out/review.yaml` file
// content — no `---` delimiters, no code fences, no trailing chat prose: the
// entire file IS the YAML (assemble.ts's CODE_REVIEW_RESPONSE_FORMAT).
// ---------------------------------------------------------------------------

const PASS_HEADER = `outcome: pass
findings:
  - id: F1
    severity: low
    blocking: false
    summary: "Minor style nit"
    detail: "Consider renaming the variable for clarity"
    ac: AC-1
acceptance_criteria:
  - criterion: "AC-1: parses valid header"
    pass: true
    notes: "Looks good"
`;

const CHANGES_REQUESTED_HEADER = `outcome: changes-requested
findings:
  - id: F1
    severity: high
    blocking: true
    summary: "Missing null check on line 42"
    detail: "Dereferencing without a guard can crash on empty input"
    ac: AC-2
acceptance_criteria:
  - criterion: "AC-2: handles empty input"
    pass: false
`;

const PASS_WITH_MINOR_HEADER = `outcome: pass-with-minor
findings:
  - id: F1
    severity: low
    blocking: false
    summary: "Non-blocking style nit"
acceptance_criteria:
  - criterion: "AC-1: works as specified"
    pass: true
`;

const MALFORMED_CONTENT = 'This review looks fine to me, no changes needed.\n';

const EMPTY_CONTENT = '';

const MISSING_OUTCOME_HEADER = `findings:
  - id: F1
    severity: low
    blocking: false
    summary: "A finding without a top-level outcome field"
acceptance_criteria:
  - criterion: "AC-1: something"
    pass: true
`;

const PASS_WITH_BLOCKING_FINDING = `outcome: pass
findings:
  - id: F1
    severity: high
    blocking: true
    summary: "This should not be allowed to coexist with outcome: pass"
`;

const CHANGES_REQUESTED_WITH_NO_BLOCKING = `outcome: changes-requested
findings:
  - id: F1
    severity: low
    blocking: false
    summary: "Not blocking, yet outcome claims changes-requested"
`;

const INVALID_SEVERITY_HEADER = `outcome: pass-with-minor
findings:
  - id: F1
    severity: urgent
    blocking: false
    summary: "Severity 'urgent' is not a recognized enum value"
`;

const BOOLEAN_VARIANTS_HEADER = `outcome: changes-requested
findings:
  - id: F1
    severity: high
    blocking: yes
    summary: "Uses yes/no instead of true/false"
acceptance_criteria:
  - criterion: "AC-1: boolean variants are tolerated"
    pass: no
`;

const LEADING_BLANK_LINES_HEADER = `

outcome: pass
`;

describe('response-header.ts — parseReviewFile (S6a ruling 3; W4 file artifact)', () => {
  it('parses a valid pass file', () => {
    const result = parseReviewFile(PASS_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('pass');
    expect(result.data.findings).toEqual([
      {
        id: 'F1',
        severity: 'low',
        blocking: false,
        summary: 'Minor style nit',
        detail: 'Consider renaming the variable for clarity',
        ac: 'AC-1',
      },
    ]);
    expect(result.data.acceptanceCriteria).toEqual([
      { criterion: 'AC-1: parses valid header', pass: true, notes: 'Looks good' },
    ]);
  });

  it('parses a valid changes-requested file with a blocking finding', () => {
    const result = parseReviewFile(CHANGES_REQUESTED_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('changes-requested');
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.findings[0].blocking).toBe(true);
  });

  it('parses a valid pass-with-minor file', () => {
    const result = parseReviewFile(PASS_WITH_MINOR_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('pass-with-minor');
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.findings[0].blocking).toBe(false);
  });

  it('rejects content that is not key: value shaped (e.g. accidental chat prose written to the file)', () => {
    const result = parseReviewFile(MALFORMED_CONTENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects an empty file', () => {
    const result = parseReviewFile(EMPTY_CONTENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects a file missing the outcome field', () => {
    const result = parseReviewFile(MISSING_OUTCOME_HEADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects outcome: pass combined with a blocking finding', () => {
    const result = parseReviewFile(PASS_WITH_BLOCKING_FINDING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects outcome: changes-requested with no blocking finding', () => {
    const result = parseReviewFile(CHANGES_REQUESTED_WITH_NO_BLOCKING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects an invalid severity value', () => {
    const result = parseReviewFile(INVALID_SEVERITY_HEADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('tolerates yes/no boolean variants for blocking and pass', () => {
    const result = parseReviewFile(BOOLEAN_VARIANTS_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.findings[0].blocking).toBe(true);
    expect(result.data.acceptanceCriteria[0].pass).toBe(false);
  });

  it('allows leading whitespace/blank lines', () => {
    const result = parseReviewFile(LEADING_BLANK_LINES_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// adapters/pi.ts — lastAssistantText/accumulatedText extraction (WK-0092/
// WK-0093). No longer feeds review-verdict parsing (S6a W4 moved that onto
// `.dispatch-out/review.yaml`, read directly by pipeline.ts — see the
// `pipeline.ts — .dispatch-out/review.yaml read` describe block below) —
// these fields still exist in `PiResult` for the response-doc narrative
// (`extractNeeds` reads `accumulatedText`; see foundation.test.ts's golden
// fixture describe block for that proof). Kept here as regression coverage
// for the extraction mechanics themselves, independent of what consumes them.
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — lastAssistantText/accumulatedText extraction', () => {
  // Six narration lines with no blank lines, deliberately pushing the
  // header's opening '---' to line 7 of the whole-session text — past
  // extractHeaderBlock's 5-line search window (this is the exact bug
  // reproduced: an agentic reviewer narrates and calls tools before
  // producing its structured header).
  const NARRATION = [
    'Let me look at the diff first.',
    'I will check each changed file for correctness.',
    'Then I will run the test suite.',
    'Now checking edge cases.',
    'Verifying acceptance criteria next.',
    'Finally, composing the review verdict.',
  ].join('\n') + '\n';

  function codeReviewStreamLines(): string {
    return [
      JSON.stringify({ type: 'agent_start' }),
      // Turn 1: narration text + a tool call (e.g. reading the diff), its
      // own message_end — this is what a real agentic code_review run does
      // before it ever produces the structured header. (WK-0092/WK-0093:
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
      // Turn 2: the final reply — the structured header lives here, and
      // ONLY here.
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: PASS_HEADER }],
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

    expect(result.data.accumulatedText).toBe(NARRATION + PASS_HEADER);
    expect(result.data.lastAssistantText).toBe(PASS_HEADER);
    expect(result.data.usage.totalTokens).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// pipeline.ts — .dispatch-out/review.yaml read (S6a W4). buildReviewFileReadScript
// and parseReviewFileReadOutput are pure (script builder / stdout parser)
// either side of pipeline.ts's one `execViaWsl2` round trip, same pattern as
// delivery.ts's buildEnumerateScript/parseEnumerateOutput — exercised here
// without any live WSL2/bwrap host. resolveReviewFileOutcome is the pure
// mapping from a read result to the reviewResult/reviewParseError pair
// runDispatch() threads into capture.ts.
// ---------------------------------------------------------------------------

describe('pipeline.ts — buildReviewFileReadScript / parseReviewFileReadOutput (S6a W4)', () => {
  it('builds a read-only script that checks for .dispatch-out/review.yaml under the clone', () => {
    const { scriptContent, scriptName } = buildReviewFileReadScript('/home/user/.kb-dispatch/clones/RUN-1');
    expect(scriptName).toBe('dispatch-review-file-read.sh');
    expect(scriptContent).toContain("FILE='/home/user/.kb-dispatch/clones/RUN-1/.dispatch-out/review.yaml'");
    expect(scriptContent).toContain('---REVIEW-YAML-PRESENT---');
    expect(scriptContent).toContain('---REVIEW-YAML-ABSENT---');
  });

  it('parses PRESENT output with content into { present: true, content }', () => {
    const stdout = [
      '---REVIEW-YAML-PRESENT---',
      '---REVIEW-YAML-CONTENT-START---',
      'outcome: pass',
      '---REVIEW-YAML-CONTENT-END---',
      '',
    ].join('\n');
    const result = parseReviewFileReadOutput(stdout);
    expect(result).toEqual({ present: true, content: 'outcome: pass' });
  });

  it('parses ABSENT output into { present: false, content: "" }', () => {
    const stdout = [
      '---REVIEW-YAML-ABSENT---',
      '---REVIEW-YAML-CONTENT-START---',
      '---REVIEW-YAML-CONTENT-END---',
      '',
    ].join('\n');
    const result = parseReviewFileReadOutput(stdout);
    expect(result).toEqual({ present: false, content: '' });
  });

  it('reports present:true with empty content for a legitimately empty (0-byte) review.yaml', () => {
    const stdout = [
      '---REVIEW-YAML-PRESENT---',
      '---REVIEW-YAML-CONTENT-START---',
      '---REVIEW-YAML-CONTENT-END---',
      '',
    ].join('\n');
    const result = parseReviewFileReadOutput(stdout);
    expect(result.present).toBe(true);
    expect(result.content).toBe('');
  });
});

describe('pipeline.ts — resolveReviewFileOutcome (S6a W4)', () => {
  it('missing file -> reviewParseError is the literal string "missing_review_artifact", no reviewResult', () => {
    const outcome = resolveReviewFileOutcome({ present: false, content: '' });
    expect(outcome.reviewResult).toBeUndefined();
    expect(outcome.reviewParseError).toBe('missing_review_artifact');
  });

  it('present + valid YAML -> reviewResult set, no reviewParseError', () => {
    const outcome = resolveReviewFileOutcome({ present: true, content: PASS_HEADER });
    expect(outcome.reviewParseError).toBeUndefined();
    expect(outcome.reviewResult?.outcome).toBe('pass');
  });

  it('present + invalid YAML -> reviewParseError is "REVIEW_PARSE_FAILED: <detail>", no reviewResult', () => {
    const outcome = resolveReviewFileOutcome({ present: true, content: MALFORMED_CONTENT });
    expect(outcome.reviewResult).toBeUndefined();
    expect(outcome.reviewParseError).toMatch(/^REVIEW_PARSE_FAILED: /);
  });

  it('present + empty content -> reviewParseError is REVIEW_PARSE_FAILED, no reviewResult', () => {
    const outcome = resolveReviewFileOutcome({ present: true, content: '' });
    expect(outcome.reviewResult).toBeUndefined();
    expect(outcome.reviewParseError).toMatch(/^REVIEW_PARSE_FAILED: /);
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
    expect(result.data.text).toContain('outcome: pass | pass-with-minor | changes-requested');
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
    expect(result.data.text).toContain('blocked');
  });

  it('research framing casts the worker as a research investigator', async () => {
    const result = await assembleForMode('research');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('research investigator');
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
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['true'],
    status: 'draft',
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
// capture.ts — Structured Review section rendering (S6a)
// ---------------------------------------------------------------------------

describe('capture.ts — Structured Review section rendering (S6a)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-s6a-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'code_review' };
  const delivery: DeliveryOutcome = { status: 'no_changes' };

  it('includes a ## Structured Review section when reviewResult is present', async () => {
    const reviewResult: StructuredReviewResult = {
      outcome: 'pass',
      findings: [],
      acceptanceCriteria: [{ criterion: 'AC-1: Works', pass: true }],
    };

    const result = await writeResponseDoc({ runDir, handoff, delivery, reviewResult });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('## Structured Review');
    expect(written).toContain('**Outcome:** pass');
  });

  it('omits the Structured Review section when reviewResult is absent', async () => {
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).not.toContain('Structured Review');
  });

  it('renders a ## Structured Review parse-failure notice when reviewParseError is present and reviewResult is absent (S6a non-silent fix)', async () => {
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      reviewParseError: "No opening '---' header delimiter found in the first 5 line(s) of the response.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('## Structured Review');
    expect(written).toContain('**Parse failed:**');
    expect(written).toContain("No opening '---' header delimiter found");
  });

  it('prefers reviewResult over reviewParseError when both are somehow present', async () => {
    const reviewResult: StructuredReviewResult = {
      outcome: 'pass',
      findings: [],
      acceptanceCriteria: [{ criterion: 'AC-1: Works', pass: true }],
    };

    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      reviewResult,
      reviewParseError: 'should never be rendered',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await readFile(result.data.responsePath, 'utf8');
    expect(written).toContain('**Outcome:** pass');
    expect(written).not.toContain('Parse failed');
    expect(written).not.toContain('should never be rendered');
  });
});
