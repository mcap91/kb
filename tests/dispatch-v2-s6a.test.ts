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
  parseReviewHeader,
  parseHandoffContent,
  assemblePrompt,
  checkAdmission,
  writeResponseDoc,
  parsePiOutput,
  type Handoff,
  type DeliveryOutcome,
  type StructuredReviewResult,
} from '@kb/dispatch-core';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// response-header.ts — parseReviewHeader (S6a ruling 3)
// ---------------------------------------------------------------------------

const PASS_HEADER = `---
outcome: pass
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
---

Detailed prose analysis follows.
`;

const CHANGES_REQUESTED_HEADER = `---
outcome: changes-requested
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
---

Blocking issue found; see finding F1.
`;

const PASS_WITH_MINOR_HEADER = `---
outcome: pass-with-minor
findings:
  - id: F1
    severity: low
    blocking: false
    summary: "Non-blocking style nit"
acceptance_criteria:
  - criterion: "AC-1: works as specified"
    pass: true
---

All acceptance criteria pass; one minor non-blocking note.
`;

const NO_DELIMITER_TEXT = 'outcome: pass\nNo header delimiters anywhere in this response, just prose.\n';

const MISSING_OUTCOME_HEADER = `---
findings:
  - id: F1
    severity: low
    blocking: false
    summary: "A finding without a top-level outcome field"
acceptance_criteria:
  - criterion: "AC-1: something"
    pass: true
---

No outcome field was set above.
`;

const PASS_WITH_BLOCKING_FINDING = `---
outcome: pass
findings:
  - id: F1
    severity: high
    blocking: true
    summary: "This should not be allowed to coexist with outcome: pass"
---

Contradiction: outcome claims pass but a finding is blocking.
`;

const CHANGES_REQUESTED_WITH_NO_BLOCKING = `---
outcome: changes-requested
findings:
  - id: F1
    severity: low
    blocking: false
    summary: "Not blocking, yet outcome claims changes-requested"
---

Contradiction: outcome claims changes-requested but no finding is blocking.
`;

const INVALID_SEVERITY_HEADER = `---
outcome: pass-with-minor
findings:
  - id: F1
    severity: urgent
    blocking: false
    summary: "Severity 'urgent' is not a recognized enum value"
---

Invalid severity value should fail the parse.
`;

const BOOLEAN_VARIANTS_HEADER = `---
outcome: changes-requested
findings:
  - id: F1
    severity: high
    blocking: yes
    summary: "Uses yes/no instead of true/false"
acceptance_criteria:
  - criterion: "AC-1: boolean variants are tolerated"
    pass: no
---

Boolean fields spelled as yes/no rather than true/false.
`;

const LEADING_BLANK_LINES_HEADER = `

---
outcome: pass
---

Blank lines precede the opening delimiter above.
`;

describe('response-header.ts — parseReviewHeader (S6a ruling 3)', () => {
  it('parses a valid pass header', () => {
    const result = parseReviewHeader(PASS_HEADER);
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

  it('parses a valid changes-requested header with a blocking finding', () => {
    const result = parseReviewHeader(CHANGES_REQUESTED_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('changes-requested');
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.findings[0].blocking).toBe(true);
  });

  it('parses a valid pass-with-minor header', () => {
    const result = parseReviewHeader(PASS_WITH_MINOR_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe('pass-with-minor');
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.findings[0].blocking).toBe(false);
  });

  it('rejects a response with no opening delimiter', () => {
    const result = parseReviewHeader(NO_DELIMITER_TEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects a header missing the outcome field', () => {
    const result = parseReviewHeader(MISSING_OUTCOME_HEADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects outcome: pass combined with a blocking finding', () => {
    const result = parseReviewHeader(PASS_WITH_BLOCKING_FINDING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects outcome: changes-requested with no blocking finding', () => {
    const result = parseReviewHeader(CHANGES_REQUESTED_WITH_NO_BLOCKING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('rejects an invalid severity value', () => {
    const result = parseReviewHeader(INVALID_SEVERITY_HEADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
  });

  it('tolerates yes/no boolean variants for blocking and pass', () => {
    const result = parseReviewHeader(BOOLEAN_VARIANTS_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.findings[0].blocking).toBe(true);
    expect(result.data.acceptanceCriteria[0].pass).toBe(false);
  });

  it('allows whitespace/blank lines before the opening delimiter', () => {
    const result = parseReviewHeader(LEADING_BLANK_LINES_HEADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// adapters/pi.ts + response-header.ts — S6a bug fix: the structured review
// header must be parsed from the worker's LAST assistant message, not the
// whole-session `accumulatedText`. Reproduces the original silent-failure
// symptom (narration pushes the header past the 5-line search window) and
// proves the fix (`lastAssistantText` isolates the final message).
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — lastAssistantText isolates the review header (S6a fix)', () => {
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
      // Turn 1: narration + a tool call (e.g. reading the diff), its own
      // message_end — this is what a real agentic code_review run does
      // before it ever produces the structured header.
      JSON.stringify({ type: 'text_delta', message: { content: NARRATION } }),
      JSON.stringify({ type: 'toolcall_start', name: 'bash' }),
      JSON.stringify({ type: 'tool_execution_end', output: 'diff --git a/foo b/foo' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 40, cost: { total: 0.0004 } } },
      }),
      JSON.stringify({ type: 'turn_end', stopReason: 'tool_calls' }),
      // Turn 2: the final reply — the structured header lives here, and
      // ONLY here.
      JSON.stringify({ type: 'text_delta', message: { content: PASS_HEADER } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 15, cost: { total: 0.0001 } } },
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

  it('reproduces the bug: parseReviewHeader on accumulatedText fails (narration pushes the header past the 5-line window)', () => {
    const parsed = parsePiOutput(codeReviewStreamLines());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = parseReviewHeader(parsed.data.accumulatedText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('REVIEW_PARSE_FAILED');
    expect(result.message).toMatch(/No opening '---' header delimiter found/);
  });

  it('proves the fix: parseReviewHeader on lastAssistantText parses deterministically', () => {
    const parsed = parsePiOutput(codeReviewStreamLines());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = parseReviewHeader(parsed.data.lastAssistantText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('pass');
    expect(result.data.acceptanceCriteria).toEqual([
      { criterion: 'AC-1: parses valid header', pass: true, notes: 'Looks good' },
    ]);
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
