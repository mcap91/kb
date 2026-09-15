/**
 * Mechanical prompt assembly (spec §8 "Prompt assembly is mechanical"; T7 S0-lite,
 * T30 S6a mode framings). Wrapper templated from HO fields — mode framing + envelope +
 * task body + AC list + read_first contents. No model call here, ever. Framings are
 * subagent profiles that set posture, never guardrails (s6-rulings.md ruling 2) — all
 * guardrails are deterministic elsewhere (delivery gate, bwrap, etc). Every framing
 * instructs the worker to end any non-`completed` run by naming the exact additional
 * access or decisions it needed (the source of `.dispatch-out/outcome.yaml`'s `needs:` list).
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
  'space granted in the task below. If you encounter a missing decision, stop with outcome ' +
  '`blocked` and name what you need in the `needs:` section of `.dispatch-out/outcome.yaml` — do not ' +
  'make judgment calls.\n\n' +
  'If implementing your task requires fixing a pre-existing bug inside write_scope that ' +
  'directly blocks your objective, one targeted fix with a note in your response is ' +
  'acceptable. If you need more than one corrective change to code unrelated to your ' +
  'objective, stop — report the root cause as `blocked` with `needs:` diagnostics rather ' +
  'than patching forward.\n\n' +
  "Use the environment named in the task's `vars` field. Do not create, modify, or install " +
  'new environments (conda, mamba, venv, virtualenv). If the task requires an environment ' +
  'that is not provided, stop with outcome `blocked` and name the missing environment in ' +
  '`needs:`.';

const IMPLEMENT_RESPONSE_FORMAT = [
  '## Response Format',
  '',
  'Write your outcome to `.dispatch-out/outcome.yaml` relative to your working directory. ' +
    'The file must be valid YAML with this exact schema:',
  '',
  '```yaml',
  'outcome: completed | partial | blocked | failed',
  'needs:',
  '  - <what was missing, if not completed>',
  '```',
  '',
  'No `---` delimiters. No code fences. The entire file IS the YAML.',
  '',
  'Your chat response is free narrative for the operator — it is never parsed.',
  '',
  'Rules:',
  '- `outcome` is MANDATORY.',
  '- If not `completed`, include a `needs:` list naming the exact paths, capabilities, or ' +
    'decisions you lacked.',
].join('\n');

const REDTEAM_FRAMING =
  'Focus on: security holes, unhandled edge cases, spec violations, missing validation, ' +
  'assumptions that could fail.\n\n' +
  'Your deliverable is adversarial findings. Do not modify any files.\n\n' +
  'If bubblewrap (bwrap) sandbox is not available or known-unsupported on this host, refuse ' +
  'to proceed — report `blocked` with `needs: bwrap sandbox environment`.';

const RESEARCH_FRAMING =
  'You have read-only access to the full repository including the wiki. Use web tools if ' +
  'granted.\n\n' +
  'Your deliverable is findings and sources. Do not modify any files.';

const SIMPLE_RESPONSE_FORMAT = [
  '## Response Format',
  '',
  'Write your outcome to `.dispatch-out/outcome.yaml` relative to your working directory. ' +
    'The file must be valid YAML:',
  '',
  '```yaml',
  'outcome: completed | blocked | failed',
  'needs:',
  '  - <what was missing, if not completed>',
  '```',
  '',
  'No `---` delimiters. No code fences. The entire file IS the YAML.',
  '',
  'Your chat response is free narrative — findings, sources, analysis.',
].join('\n');

const CODE_REVIEW_RESPONSE_FORMAT = [
  '## Response Format',
  '',
  'Write your structured review verdict to the file `.dispatch-out/review.yaml` relative to ' +
    'your working directory. The file must be valid YAML with this exact schema (this MUST be ' +
    'parseable — if the file is missing or cannot be parsed deterministically, the run is ' +
    'marked `failed`):',
  '',
  '```yaml',
  'outcome: pass | pass-with-minor | changes-requested',
  'findings:',
  '  - id: F1',
  '    severity: critical | high | medium | low | info',
  '    blocking: true | false',
  '    summary: <one-line>',
  '    detail: <explanation>',
  '    ac: <which AC>',
  'acceptance_criteria:',
  '  - criterion: <AC text>',
  '    pass: true | false',
  '    notes: <optional>',
  '```',
  '',
  'No `---` delimiters. No code fences. The entire file IS the YAML.',
  '',
  'Your chat response is free narrative for the operator — it is never parsed.',
  '',
  'Rules:',
  '- `outcome` is MANDATORY. `pass` = all ACs met, no blocking findings. `pass-with-minor` = ' +
    'all ACs met, non-blocking findings exist. `changes-requested` = blocking finding(s) or AC ' +
    'failure(s).',
  '- Every finding MUST have severity and blocking fields.',
  '- Every acceptance criterion from the task MUST appear in the acceptance_criteria list with ' +
    'a pass/fail judgment.',
].join('\n');

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
          'Your deliverable is a structured review outcome, not code changes. Do not modify any files.',
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
        responseFormat: SIMPLE_RESPONSE_FORMAT,
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
