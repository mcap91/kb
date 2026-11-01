import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import { debug } from './debug.js';
import type { AgentInstructionsSection } from './contract.js';

const BEGIN_MARKER = '<!-- BEGIN kb-managed -->';
const END_MARKER = '<!-- END kb-managed -->';
const MANAGED_COMMENT = 'Managed by kb — edits inside this block are overwritten by `kb bootstrap` / `kb sync-contract`; edit outside the markers.';

// WK-0229 ruling 16: words between the markers; raise only by operator ruling recorded in WK-0229.
export const BLOCK_WORD_BUDGET = 4000;

/** Whether `wiki/.dispatch/` has been scaffolded for the target repo (WK-0229 ruling 4). */
export function dispatchInstalled(targetDir: string): boolean {
  return fs.existsSync(path.join(targetDir, 'wiki', '.dispatch'));
}

/** Assemble the managed-block body from sections, dropping dispatch-gated ones when absent. */
export function assembleBlockBody(
  sections: AgentInstructionsSection[],
  opts: { dispatch: boolean },
): string {
  return sections
    .filter(section => section.requires !== 'dispatch' || opts.dispatch)
    .map(section => section.body)
    .join('\n\n');
}

/** Count words strictly between the BEGIN/END markers (markers excluded, managed comment included). */
export function countBlockWords(body: string): number {
  const wrapped = buildWrappedBlock(body);
  const beginIdx = wrapped.indexOf(BEGIN_MARKER);
  const endIdx = wrapped.indexOf(END_MARKER);
  const between = wrapped.slice(beginIdx + BEGIN_MARKER.length, endIdx);
  return between.split(/\s+/).filter(Boolean).length;
}

/**
 * Check the managed block against the WK-0229 ruling 16 budget, assembled with every
 * section present (the largest block sync can emit) so a repo without dispatch never
 * hides an overflow.
 */
export function checkBlockBudget(
  sections: AgentInstructionsSection[],
): Result<{ words: number; budget: number }> {
  const body = assembleBlockBody(sections, { dispatch: true });
  const words = countBlockWords(body);

  if (words > BLOCK_WORD_BUDGET) {
    return fail(
      'BLOCK_BUDGET_EXCEEDED',
      `Managed block is ${words} words; budget is ${BLOCK_WORD_BUDGET} (WK-0229 ruling 16). Raise the budget by operator ruling or trim the contract text.`,
    );
  }

  return ok({ words, budget: BLOCK_WORD_BUDGET });
}

const TARGET_FILES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * CLAUDE.md's managed block is a thin redirect to AGENTS.md (the Claude Code
 * file-reference directive). AGENTS.md remains the canonical content and
 * never references itself.
 */
const CLAUDE_POINTER = '@AGENTS.md';

interface ManagedBlockEntry {
  file: string;
  action: 'created' | 'updated' | 'unchanged';
}

interface WriteManagedBlockOpts {
  dryRun?: boolean;
}

function buildWrappedBlock(body: string): string {
  return `${BEGIN_MARKER}\n${MANAGED_COMMENT}\n\n${body}\n${END_MARKER}`;
}

function processFile(
  filePath: string,
  wrappedBlock: string,
  dryRun: boolean,
): ManagedBlockEntry {
  const fileName = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, wrappedBlock + '\n', 'utf-8');
    }
    debug(`created ${fileName} with managed block`);
    return { file: fileName, action: 'created' };
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    const currentBlock = existing.slice(beginIdx, endIdx + END_MARKER.length);

    if (currentBlock === wrappedBlock) {
      debug(`${fileName} managed block unchanged`);
      return { file: fileName, action: 'unchanged' };
    }

    const updated = before + wrappedBlock + after;
    if (!dryRun) {
      fs.writeFileSync(filePath, updated, 'utf-8');
    }
    debug(`updated managed block in ${fileName}`);
    return { file: fileName, action: 'updated' };
  }

  // No markers — insert after leading H1 or at top
  const lines = existing.split('\n');
  let insertIdx = 0;
  if (lines.length > 0 && lines[0].startsWith('# ')) {
    insertIdx = 1;
  }

  const before = lines.slice(0, insertIdx).join('\n');
  const after = lines.slice(insertIdx).join('\n');

  let result: string;
  if (before) {
    result = before + '\n\n' + wrappedBlock + '\n' + (after.startsWith('\n') ? after : '\n' + after);
  } else {
    result = wrappedBlock + '\n' + (after.startsWith('\n') ? after : '\n' + after);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, result, 'utf-8');
  }
  debug(`inserted managed block into ${fileName}`);
  return { file: fileName, action: 'created' };
}

/**
 * Write the kb-managed agent-instructions block to AGENTS.md and CLAUDE.md.
 *
 * Content differs per target file: AGENTS.md receives the full blockBody
 * template; CLAUDE.md receives only the `@AGENTS.md` directive (inside the
 * managed markers) so it is a thin redirect to the canonical AGENTS.md.
 */
export function writeManagedBlock(
  targetDir: string,
  blockBody: string,
  opts?: WriteManagedBlockOpts,
): Result<ManagedBlockEntry[]> {
  const dryRun = opts?.dryRun ?? false;
  const results: ManagedBlockEntry[] = [];

  for (const file of TARGET_FILES) {
    const filePath = path.join(targetDir, file);
    const body = file === 'CLAUDE.md' ? CLAUDE_POINTER : blockBody;
    const wrappedBlock = buildWrappedBlock(body);
    results.push(processFile(filePath, wrappedBlock, dryRun));
  }

  return ok(results);
}
