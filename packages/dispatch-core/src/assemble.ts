/**
 * Mechanical prompt assembly (spec §8 "Prompt assembly is mechanical"; T7 S0-lite).
 * Wrapper templated from HO fields — mode framing + envelope + task body + AC list +
 * read_first contents. No model call here, ever. Rev-5 implement framing: no
 * unratified decisions outside the HO-granted decision space; every framing instructs
 * the worker to end any non-`completed` run by naming the exact additional access or
 * decisions it needed (the source of the response header's `needs:` list).
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

  const sections: string[] = [
    'You are a coding agent executing a handoff task.',
    '## Framing\n' +
      'Execute the spec exactly. You have NO unratified decisions to make outside the decision ' +
      'space granted in the task below. If you encounter a missing decision, stop with outcome ' +
      '`blocked` and name what you need in the `needs:` section of your response header — do not ' +
      'make judgment calls.',
    `## Task: ${handoff.title}`,
    `### Context\n${context}`,
    `### Write Scope\nYou may ONLY create or modify files under these paths:\n${bulletList(handoff.write_scope)}`,
    `### Acceptance Criteria\n${bulletList(handoff.acceptance)}`,
    `### Validation\nRun these commands to verify your work:\n${bulletList(handoff.validation)}`,
  ];

  let readFirstSection = `### Read First\nRead these files before starting:\n${bulletList(handoff.read_first)}`;
  if (readFirstBlocks.length > 0) {
    readFirstSection += `\n\n${readFirstBlocks.join('\n\n')}`;
  }
  sections.push(readFirstSection);

  sections.push(
    '## Response Format\n' +
      'When complete, report your outcome as:\n' +
      '- outcome: completed | partial | blocked | failed\n' +
      '- If not `completed`, include a `needs:` list naming the exact paths, capabilities, or ' +
      'decisions you lacked.',
  );

  const text = sections.join('\n\n');
  return ok({ text, tokenEstimate: Math.ceil(text.length / 4) });
}
