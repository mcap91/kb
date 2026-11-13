/**
 * Mechanical prompt assembly (spec §8 "Prompt assembly is mechanical"; T7 S0-lite,
 * T30 S6a mode framings). Wrapper templated from HO fields — mode framing + envelope +
 * task body + AC list + read_first pointers. No model call here, ever. Framings are
 * subagent profiles that set posture, never guardrails (s6-rulings.md ruling 2) — all
 * guardrails are deterministic elsewhere (delivery gate, bwrap, etc). Every framing
 * instructs the worker that if it cannot finish, its final chat message should state
 * exactly what it needed and why it stopped — diagnosis only (DEC-0010): that text is
 * embedded verbatim as the response doc's `## Worker Report` evidence section
 * (capture.ts) and is never parsed or consulted by the mechanical verdict ladder.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import type { Handoff } from './ho.js';
import type { StagedReviewEvidence } from './host-validation.js';
import type { BackendFamily } from './repo-config.js';

export interface AssembledPrompt {
  text: string;
  /** Rough char/4 estimate — not a tokenizer call (spec §7.13 context-budget gate is Wave 3). */
  tokenEstimate: number;
}

// New v2 error code produced by this module; will be merged into the shared
// DispatchErrorCode union in errors.ts at wave-3 integration. errors.ts is not
// modified by this file (wave-1 constraint).
type AssembleErrorCode = 'ASSEMBLE_FAILED';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'ASSEMBLE_FAILED' as AssembleErrorCode, message, detail } as unknown as DispatchResult<T>;
}

function extractBody(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return (match ? match[1] : normalized) ?? '';
}

function bulletList(entries: string[]): string {
  return entries.map((entry) => `- ${entry}`).join('\n');
}

/**
 * `kb-dispatch-recovery.v1` terminal block plumbing (mid_project_review_rulings.md ruling 1;
 * schema/transport adapted from agent-chassis's `agent-role-result.v1` — ELv2: mirrored
 * design, TypeScript written from scratch, no copied code. Chassis source:
 * `work-record-launch-prompt.mjs:157-175,205-209` (terminal fenced-block transport rules +
 * example-rendering pattern), `agent-role-result.v1.schema.json` (field shapes).
 *
 * Transport: exactly one fenced block, info-string `kb-dispatch-recovery.v1`, as the LAST
 * content in the worker's output (ruling 1 item 2). The consequence of a missing/malformed
 * block is role-dependent and stated in each responseFormat constant below, not here: for
 * `implement` it costs only diagnostic evidence (ruling 1 item 8); for `code_review`/`redteam`/
 * `research` the prose is the deliverable and the block is optional structured metadata — its
 * absence does not fail the run (DEC-0037 reverses V4 note 3; WK-0145 widens this optional-
 * metadata treatment to research). WK-0146 removed pipeline.ts's research mode-gate —
 * extraction now runs for every mode, and `researcher` is a valid `reported_role`.
 */
const RECOVERY_BLOCK_INTRO =
  'As the LAST content in your output, emit exactly one fenced JSON block whose info-string ' +
  'is exactly `kb-dispatch-recovery.v1`. Do not emit ordinary ```json fences, extra JSON ' +
  'candidates, or any content after the closing fence.';

function recoveryBlockExample(example: Record<string, unknown>): string {
  return ['```kb-dispatch-recovery.v1', JSON.stringify(example, null, 2), '```'].join('\n');
}

/**
 * Shared instruction body for `code_review`, `redteam`, `research`, and `explore_code` —
 * identical payload shape (ruling 1 item 4: "redteam | Same as reviewer"; WK-0145 extends
 * the same optional-metadata treatment to research; WK-0183 extends it again to
 * explore_code's `explorer` role), differing only in `reported_role`.
 */
function reviewerRecoveryFormat(role: 'reviewer' | 'redteam' | 'researcher' | 'explorer'): string {
  const example = recoveryBlockExample({
    schema_version: 'kb-dispatch-recovery.v1',
    reported_role: role,
    reported_subject: '<handoff id>',
    reported_outcome: 'changes_requested',
    summary: '<one-paragraph summary of the review>',
    findings: [
      {
        id: 'F1',
        title: '<short finding title>',
        severity: 'high',
        blocking: true,
        affected_paths: [{ path: 'src/foo.ts', line: 42 }],
        control_id: null,
      },
    ],
    finding_counts: { total: 1, blocking: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    reviewed_controls: [{ control_id: 'acceptance_criteria', result: 'fail' }],
  });

  return (
    '## Recovery Signal\n\n' +
    `${RECOVERY_BLOCK_INTRO}\n\n` +
    'Your prose review above is the primary deliverable — it is what gets read and acted on. ' +
    'If you can, emit this block as the last content in your output: it gives the orchestrator ' +
    'structured data for automation, an opportunistic shortcut, not a requirement. A missing ' +
    'block, or one that cannot be parsed, does not fail the run.\n\n' +
    `\`reported_role\` is \`"${role}"\`. \`reported_subject\` is the handoff id you were ` +
    'dispatched as. `reported_outcome` is one of `no_findings` | ' +
    '`passed_no_blocking_or_medium_findings` | `changes_requested`. `no_findings` requires ' +
    'an empty `findings` array and all-zero `finding_counts`. ' +
    '`passed_no_blocking_or_medium_findings` permits only `low`/`info` findings and zero ' +
    'blocking/critical/high/medium counts. Any blocking, critical, high, or medium finding ' +
    'MUST appear in `findings[]`, MUST use `changes_requested`, and blocks a clean outcome.\n\n' +
    '`findings`, `finding_counts`, and `reviewed_controls` are REQUIRED for this role. Each ' +
    'finding is `{id, title, severity, blocking, affected_paths, control_id}` — `severity` ' +
    'is one of critical|high|medium|low|info, `affected_paths` is an array of ' +
    '`{"path": "src/foo.ts", "line": 42}` (or `"line": null` when no specific line applies). ' +
    '`finding_counts` (`{total, blocking, critical, high, medium, low, info}`) MUST match ' +
    '`findings`. Each `reviewed_controls` entry is `{control_id, result}` with `result` of ' +
    '`pass` or `fail`, listing controls you actually reviewed.\n\n' +
    'Your chat response outside the block is free narrative for the operator — it is never ' +
    'parsed.\n\n' +
    example
  );
}

/**
 * WK-0273 (operator ruling (a), 2026-11-12): the managed block's "search the kb wiki first"
 * step cannot run inside the jail — no kb MCP server and no kb checkout are mounted there.
 * This line overrides that step for every mode's worker prompt from one place in shared
 * assembly code (see `assemblePrompt`'s Framing section), rather than being pasted into each
 * mode's framing constant.
 */
const JAIL_RETRIEVAL_LINE =
  'In this jail, read the wiki as plain files; the `read_first` list in this task is your ' +
  'retrieval set. Do not look for a kb MCP server or kb CLI — neither is mounted here.';

interface ModeParts {
  introLine: string;
  framing: string;
  includeWriteScope: boolean;
  includeAcceptance: boolean;
  includeValidation: boolean;
  responseFormat: string;
}

const IMPLEMENT_FRAMING =
  'Execute the spec exactly. You have NO unratified decisions to make outside the decision ' +
  'space granted in the task below. If you encounter a missing decision, stop and end your ' +
  'final message stating exactly what you needed and why you stopped — do not make judgment ' +
  'calls.\n\n' +
  'If implementing your task requires fixing a pre-existing bug inside write_scope that ' +
  'directly blocks your objective, one targeted fix with a note in your response is ' +
  'acceptable. If you need more than one corrective change to code unrelated to your ' +
  'objective, stop — end your final message stating the root cause and exactly what you ' +
  'needed, rather than patching forward.\n\n' +
  "Use the environment named in the task's `vars` field. Do not create, modify, or install " +
  'new environments (conda, mamba, venv, virtualenv). If the task requires an environment ' +
  'that is not provided, stop and end your final message stating exactly what you needed and ' +
  'why you stopped.\n\n' +
  'Do not run `git add`/`git commit` — `.git` is read-only; dispatch captures and commits ' +
  'your changes after you finish.';

const WORKER_RECOVERY_FIELDS = {
  schema_version: 'kb-dispatch-recovery.v1',
  reported_role: 'worker',
  reported_subject: '<handoff id>',
  reported_outcome: 'completed',
  summary: '<one-paragraph summary of what you did>',
  findings: [],
  finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  reviewed_controls: [],
};

const IMPLEMENT_RESPONSE_FORMAT_BASE =
  'If you cannot finish, end your final message stating exactly what you needed and why you ' +
  'stopped.\n\n' +
  '## Recovery Signal\n\n' +
  `${RECOVERY_BLOCK_INTRO}\n\n` +
  'This block is diagnostic evidence only — delivery authority is the scope-checked commit, ' +
  'not this block. Failing to emit it, or emitting it malformed, loses only diagnostic ' +
  'evidence and never invalidates an authenticated delivery.\n\n' +
  '`reported_role` is `"worker"`. `reported_subject` is the handoff id you were dispatched ' +
  'as. `reported_outcome` is one of `completed` | `partial` | `blocked` | `failed`. If not ' +
  '`completed`, also include `kind`: one of `scope_insufficient` | ' +
  '`dependency_missing` | `spec_unclear` | `partial_progress` | `resource_limit`. `findings`, ' +
  '`finding_counts`, and `reviewed_controls` are required fields but MAY be populated with ' +
  'real observations from your work (e.g. a pre-existing bug you noticed) — they are ' +
  'evidence, not a verdict on your own work.\n\n';

/** Pi implement (no constrained decoding): prose and block share the final message, as before WK-0251. */
const IMPLEMENT_RESPONSE_FORMAT = IMPLEMENT_RESPONSE_FORMAT_BASE + recoveryBlockExample(WORKER_RECOVERY_FIELDS);

/**
 * Claude/codex implement (WK-0251): DEC-0037 constrained decoding makes the
 * final message schema-only JSON, so the report has no channel but the
 * block's `report` field (required in contract/kb-dispatch-recovery.v1.schema.json).
 */
const CONSTRAINED_IMPLEMENT_RESPONSE_FORMAT =
  IMPLEMENT_RESPONSE_FORMAT_BASE +
  'Your final message IS this JSON block — there is no separate chat message for prose — so put ' +
  'your full human-readable report in `report` (a markdown string): what you changed, ' +
  'before/after quotes, the validation commands you ran with their output tails, and anything ' +
  "this task's Expected Output asked for. `report` is the only place that report reaches the operator.\n\n" +
  recoveryBlockExample({
    ...WORKER_RECOVERY_FIELDS,
    report:
      '<the full human-readable report for this handoff: what changed, before/after quotes, ' +
      "the validation commands you ran with their output tails, and anything this task's " +
      'Expected Output asked for>',
  });

const REDTEAM_FRAMING =
  'Focus on the full adversarial surface: security holes, unhandled edge cases, spec gaps, ' +
  'missing decisions, unstated assumptions, shapes defined by guessing instead of capture ' +
  '(evidence discipline violations), structural complexity, over-engineering, connectedness ' +
  'gaps (missing links, orphaned dependencies), assumption rot — things that will break when ' +
  'context changes, and spec violations or missing validation.\n\n' +
  'Your deliverable is adversarial findings. Do not modify any files.\n\n' +
  'If bubblewrap (bwrap) sandbox is not available or known-unsupported on this host, refuse ' +
  'to proceed — stop and state in your final message that you need a bwrap sandbox environment.';

const REDTEAM_RESPONSE_FORMAT = reviewerRecoveryFormat('redteam');

const RESEARCH_FRAMING =
  'You have read-only access to the full repository including the wiki. Use web tools if ' +
  'granted.\n\n' +
  'Your deliverable is findings and sources. Do not modify any files.\n\n' +
  'If you cannot finish, end your final message stating exactly what you needed and why you stopped.';

const RESEARCH_RESPONSE_FORMAT = reviewerRecoveryFormat('researcher');

const EXPLORE_CODE_FRAMING =
  'You have read-only access to the full repository including the wiki. This is codebase ' +
  'investigation, not web research — no web tools are granted.\n\n' +
  'Your deliverable is structured findings about the codebase. Do not modify any files.\n\n' +
  'If you cannot finish, end your final message stating exactly what you needed and why you stopped.';

const EXPLORE_CODE_RESPONSE_FORMAT = reviewerRecoveryFormat('explorer');

const SIMPLE_RESPONSE_FORMAT =
  'If you cannot finish, end your final message stating exactly what you needed and why you stopped.';

const CODE_REVIEW_RESPONSE_FORMAT = reviewerRecoveryFormat('reviewer');

/** Mode framings are subagent profiles (posture), never guardrails — s6-rulings.md ruling 2. */
function getModeParts(handoff: Handoff, opts: AssembleOpts): ModeParts {
  switch (handoff.mode) {
    case 'implement':
      return {
        introLine: 'You are a coding agent executing a handoff task.',
        framing: IMPLEMENT_FRAMING,
        includeWriteScope: true,
        includeAcceptance: true,
        includeValidation: true,
        // pipeline.ts hands claude/codex implement runs the recovery schema (DEC-0037); pi gets none.
        responseFormat:
          opts.family !== undefined && opts.family !== 'pi' ? CONSTRAINED_IMPLEMENT_RESPONSE_FORMAT : IMPLEMENT_RESPONSE_FORMAT,
      };
    case 'code_review':
      return {
        introLine: 'You are a code reviewer checking this change against its acceptance criteria.',
        framing:
          // WK-0270 Specification 6: fixed text, parameterized on identifiers only — this
          // function never parses the Objective. The Objective (derived or hand-authored)
          // states the range on its own `Range under review: <range>` line; a hand-authored
          // review that names no such line falls back to the single-commit default, which
          // keeps tests/dispatch-v2-base-drift.test.ts passing unchanged.
          `Review the change delivered on \`${handoff.base_ref}\`. Your checkout is that branch's tip. ` +
          "Judge the range on the Objective's `Range under review:` line above. When the Objective names " +
          'no such line (a hand-authored review), the default is `git diff HEAD~1 HEAD` — the single ' +
          'commit each delivery adds on its base.\n\n' +
          "Check the change against the repository's AGENTS.md rules as well as the acceptance criteria " +
          'below, and name the specific rule in each finding that cites a rule violation.\n\n' +
          'Flag iterative fix-up patterns (multiple small patches to the same region, ' +
          'trial-and-error artifacts, debug residue) as a quality finding — do not auto-reject; ' +
          'the orchestrator decides disposition.\n\n' +
          // DEC-0047: advisory workers never execute the toolchain; the host ran the registered
          // validation commands and the evidence is attached (see "Host Validation Evidence").
          'Executing tests, builds, or any project toolchain is out of scope for this review: the host ' +
          'runs the registered validation commands against the delivery and attaches the results. Judge ' +
          'the diff plus that evidence; do not try to reproduce a test run.\n\n' +
          'Your deliverable is a structured review outcome, not code changes. Do not modify any files.\n\n' +
          'If you cannot finish, end your final message stating exactly what you needed and why you stopped.',
        includeWriteScope: false,
        includeAcceptance: true,
        includeValidation: false,
        responseFormat: CODE_REVIEW_RESPONSE_FORMAT,
      };
    case 'redteam':
      return {
        introLine:
          'You are an adversarial reviewer. Your job is to attack the change/claim — find what ' +
          "breaks, what's missing, what's wrong.",
        framing: REDTEAM_FRAMING,
        includeWriteScope: false,
        includeAcceptance: false,
        includeValidation: false,
        responseFormat: REDTEAM_RESPONSE_FORMAT,
      };
    case 'research':
      return {
        introLine:
          'You are a research investigator. Investigate the question/topic below and report ' +
          'findings with sources.',
        framing: RESEARCH_FRAMING,
        includeWriteScope: false,
        includeAcceptance: false,
        includeValidation: false,
        responseFormat: RESEARCH_RESPONSE_FORMAT,
      };
    case 'explore_code':
      return {
        introLine:
          'You are a code explorer. Investigate the codebase question/topic below and report ' +
          'structured findings.',
        framing: EXPLORE_CODE_FRAMING,
        includeWriteScope: false,
        includeAcceptance: true,
        includeValidation: false,
        responseFormat: EXPLORE_CODE_RESPONSE_FORMAT,
      };
  }
}

/**
 * Assemble the full worker prompt for a handoff. Reads the HO's own markdown file
 * from `wiki/handoffs/{id}.md` under repoRoot for the Context body (the parsed
 * `Handoff` frontmatter carries no body text of its own). `read_first` entries are
 * emitted as path pointers only (DEC-0039) — the worker reads them at runtime;
 * this function never reads their content and never fails over them. Only a
 * missing/unreadable HO markdown file itself (the source of Context) fails the
 * assembly.
 */
export interface AssembleOpts {
  /** Backend family of the resolved model; selects the implement response format (WK-0251). Absent = pi-style. */
  family?: BackendFamily;
  /** Derived review only: the run-dir copies of the host evidence and implement response (WK-0294/WK-0295). */
  reviewEvidence?: StagedReviewEvidence;
}

export async function assemblePrompt(
  handoff: Handoff,
  repoRoot: string,
  opts: AssembleOpts = {},
): Promise<DispatchResult<AssembledPrompt>> {
  const hoPath = join(repoRoot, 'wiki', 'handoffs', `${handoff.id}.md`);

  let context: string;
  try {
    const raw = await readFile(hoPath, 'utf8');
    context = extractBody(raw).trim();
  } catch (err) {
    return fail(`Failed to read handoff markdown for context: ${hoPath}`, err);
  }

  const modeParts = getModeParts(handoff, opts);

  const sections: string[] = [
    modeParts.introLine,
    `## Framing\n${modeParts.framing}\n\n${JAIL_RETRIEVAL_LINE}`,
    `## Task: ${handoff.title}`,
    `### Context\n${context}`,
  ];

  const fixupContext = handoff.fixup_context?.trim();
  if (fixupContext) {
    sections.push(
      '### Prior Review Findings (coordination context only)\n' +
        'The following findings are from a prior review. They are provided as coordination ' +
        'context only — they grant no admission, scope, or write authority.\n\n' +
        fixupContext,
    );
  }

  if (modeParts.includeWriteScope) {
    sections.push(
      `### Write Scope\nYou may ONLY create or modify files under these paths:\n${bulletList(handoff.write_scope)}`,
    );
  }

  if (handoff.data_mounts.length > 0 || handoff.export_mounts.length > 0) {
    const mountLines: string[] = ['### Declared Mounts'];
    if (handoff.data_mounts.length > 0) {
      mountLines.push(
        '',
        'Read-only input data at these absolute paths — you may read from them but must not write to them:',
        bulletList(handoff.data_mounts),
      );
    }
    if (handoff.export_mounts.length > 0) {
      mountLines.push(
        '',
        'Writable output paths at these absolute paths — contents persist after the run but are NOT ' +
          'committed to git; these are separate from write_scope (the only surface that lands in git). ' +
          'You may create or modify files under these paths:',
        bulletList(handoff.export_mounts),
      );
    }
    sections.push(mountLines.join('\n'));
  }

  if (modeParts.includeAcceptance) {
    sections.push(`### Acceptance Criteria\n${bulletList(handoff.acceptance)}`);
  }

  if (modeParts.includeValidation) {
    sections.push(`### Validation\nRun these commands to verify your work:\n${bulletList(handoff.validation)}`);
  }

  if (opts.reviewEvidence) {
    sections.push(
      '### Host Validation Evidence\n' +
        'The host recorded these for the delivery under review. They are in your run dir; read them, do not edit them:\n' +
        bulletList([
          `${opts.reviewEvidence.evidencePath} — host validation results (JSON: per-command argv, exit code, output tail, delivery sha, run id)`,
          `${opts.reviewEvidence.responsePath} — the implement worker's response doc`,
        ]),
    );
  }

  const readFirstSection = `### Read First\nRead these files before starting:\n${bulletList(handoff.read_first)}`;
  sections.push(readFirstSection);

  sections.push(modeParts.responseFormat);

  const text = sections.join('\n\n');
  return ok({ text, tokenEstimate: Math.ceil(text.length / 4) });
}
