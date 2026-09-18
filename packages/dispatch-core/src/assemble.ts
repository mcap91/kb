/**
 * Mechanical prompt assembly (spec §8 "Prompt assembly is mechanical"; T7 S0-lite,
 * T30 S6a mode framings). Wrapper templated from HO fields — mode framing + envelope +
 * task body + AC list + read_first contents. No model call here, ever. Framings are
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
 * `implement` it costs only diagnostic evidence (ruling 1 item 8); for `code_review`/`redteam`
 * the block IS the mode deliverable and its absence fails the run (V4 note 3). `research` gets
 * no block at all (ruling 1 item 1) — never wire this into RESEARCH_FRAMING/SIMPLE_RESPONSE_FORMAT.
 */
const RECOVERY_BLOCK_INTRO =
  'As the LAST content in your output, emit exactly one fenced JSON block whose info-string ' +
  'is exactly `kb-dispatch-recovery.v1`. Do not emit ordinary ```json fences, extra JSON ' +
  'candidates, or any content after the closing fence.';

function recoveryBlockExample(example: Record<string, unknown>): string {
  return ['```kb-dispatch-recovery.v1', JSON.stringify(example, null, 2), '```'].join('\n');
}

/**
 * Shared instruction body for `code_review` and `redteam` — identical payload shape (ruling 1
 * item 4: "redteam | Same as reviewer"), differing only in `reported_role`.
 */
function reviewerRecoveryFormat(role: 'reviewer' | 'redteam'): string {
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
    'This block IS your deliverable — it is not diagnostic evidence on the side. If it is ' +
    'missing, or present but cannot be parsed, the run is marked `failed`.\n\n' +
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
  'why you stopped.';

const WORKER_RECOVERY_EXAMPLE = recoveryBlockExample({
  schema_version: 'kb-dispatch-recovery.v1',
  reported_role: 'worker',
  reported_subject: '<handoff id>',
  reported_outcome: 'completed',
  summary: '<one-paragraph summary of what you did>',
  findings: [],
  finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  reviewed_controls: [],
});

const IMPLEMENT_RESPONSE_FORMAT =
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
  'evidence, not a verdict on your own work.\n\n' +
  WORKER_RECOVERY_EXAMPLE;

const REDTEAM_FRAMING =
  'Focus on: security holes, unhandled edge cases, spec violations, missing validation, ' +
  'assumptions that could fail.\n\n' +
  'Your deliverable is adversarial findings. Do not modify any files.\n\n' +
  'If bubblewrap (bwrap) sandbox is not available or known-unsupported on this host, refuse ' +
  'to proceed — stop and state in your final message that you need a bwrap sandbox environment.';

const REDTEAM_RESPONSE_FORMAT = reviewerRecoveryFormat('redteam');

const RESEARCH_FRAMING =
  'You have read-only access to the full repository including the wiki. Use web tools if ' +
  'granted.\n\n' +
  'Your deliverable is findings and sources. Do not modify any files.\n\n' +
  'If you cannot finish, end your final message stating exactly what you needed and why you stopped.';

const SIMPLE_RESPONSE_FORMAT =
  'If you cannot finish, end your final message stating exactly what you needed and why you stopped.';

const CODE_REVIEW_RESPONSE_FORMAT = reviewerRecoveryFormat('reviewer');

/** Mode framings are subagent profiles (posture), never guardrails — s6-rulings.md ruling 2. */
function getModeParts(handoff: Handoff): ModeParts {
  switch (handoff.mode) {
    case 'implement':
      return {
        introLine: 'You are a coding agent executing a handoff task.',
        framing: IMPLEMENT_FRAMING,
        includeWriteScope: true,
        includeAcceptance: true,
        includeValidation: true,
        responseFormat: IMPLEMENT_RESPONSE_FORMAT,
      };
    case 'code_review':
      return {
        introLine: 'You are a code reviewer checking this change against its acceptance criteria.',
        framing:
          `Review the diff on the \`dispatch/${handoff.id}\` branch (visible via \`base_ref\`) ` +
          'against the acceptance criteria below.\n\n' +
          'Flag iterative fix-up patterns (multiple small patches to the same region, ' +
          'trial-and-error artifacts, debug residue) as a quality finding — do not auto-reject; ' +
          'the orchestrator decides disposition.\n\n' +
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
        responseFormat: SIMPLE_RESPONSE_FORMAT,
      };
  }
}

/**
 * Assemble the full worker prompt for a handoff. Reads the HO's own markdown file
 * from `wiki/handoffs/{id}.md` under repoRoot for the Context body (the parsed
 * `Handoff` frontmatter carries no body text of its own), and best-effort-inlines
 * each `read_first` file's content. A `read_first` entry that cannot be read is
 * annotated in place, not treated as a failure — only a missing/unreadable HO
 * markdown file itself (the source of Context) fails the assembly.
 */
export async function assemblePrompt(handoff: Handoff, repoRoot: string): Promise<DispatchResult<AssembledPrompt>> {
  const hoPath = join(repoRoot, 'wiki', 'handoffs', `${handoff.id}.md`);

  let context: string;
  try {
    const raw = await readFile(hoPath, 'utf8');
    context = extractBody(raw).trim();
  } catch (err) {
    return fail(`Failed to read handoff markdown for context: ${hoPath}`, err);
  }

  const readFirstBlocks: string[] = [];
  for (const relPath of handoff.read_first) {
    const absPath = join(repoRoot, relPath);
    try {
      const fileContent = await readFile(absPath, 'utf8');
      readFirstBlocks.push(`<file path="${relPath}">\n${fileContent}\n</file>`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      readFirstBlocks.push(`<file path="${relPath}">\n[unreadable: ${detail}]\n</file>`);
    }
  }

  const modeParts = getModeParts(handoff);

  const sections: string[] = [
    modeParts.introLine,
    `## Framing\n${modeParts.framing}`,
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

  if (modeParts.includeAcceptance) {
    sections.push(`### Acceptance Criteria\n${bulletList(handoff.acceptance)}`);
  }

  if (modeParts.includeValidation) {
    sections.push(`### Validation\nRun these commands to verify your work:\n${bulletList(handoff.validation)}`);
  }

  let readFirstSection = `### Read First\nRead these files before starting:\n${bulletList(handoff.read_first)}`;
  if (readFirstBlocks.length > 0) {
    readFirstSection += `\n\n${readFirstBlocks.join('\n\n')}`;
  }
  sections.push(readFirstSection);

  sections.push(modeParts.responseFormat);

  const text = sections.join('\n\n');
  return ok({ text, tokenEstimate: Math.ceil(text.length / 4) });
}
