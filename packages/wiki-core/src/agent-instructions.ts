import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import { debug } from './debug.js';
import type { AgentInstructionsSection } from './contract.js';
import type { ContractLayer, WikiContractMetadata } from './types.js';

const BEGIN_MARKER = '<!-- BEGIN kb-managed -->';
const END_MARKER = '<!-- END kb-managed -->';
const MANAGED_COMMENT = 'Managed by kb — edits inside this block are overwritten by `kb bootstrap` / `kb sync-contract`; edit outside the markers.';

// WK-0229 ruling 16: words between the markers; raise only by operator ruling recorded in WK-0229.
export const BLOCK_WORD_BUDGET = 4000;

/** Whether `wiki/.dispatch/` has been scaffolded for the target repo (WK-0229 ruling 4). */
export function dispatchInstalled(targetDir: string): boolean {
  return fs.existsSync(path.join(targetDir, 'wiki', '.dispatch'));
}

/**
 * Whether the planning layer is active (WK-0261 Resolutions rows 2, 11): a `"planning"`
 * entry in the committed `wiki/.wiki-contract.json`, or `wiki/.dispatch/` (dispatch
 * implies planning). A missing stamp file or missing `layers` field means no planning
 * entry.
 *
 * A stamp that exists but does not parse, or that parses to a non-object, fails with
 * `PARSE_ERROR` naming the file — never a quiet "no planning" downgrade. The stamp is
 * parsed before the dispatch short-circuit so a corrupt stamp fails even in a dispatch
 * repo. The only non-failing read of `wiki/.dispatch/` is its presence.
 */
export function planningInstalled(targetDir: string): Result<boolean> {
  const contractPath = path.join(targetDir, 'wiki', '.wiki-contract.json');
  if (!fs.existsSync(contractPath)) return ok(dispatchInstalled(targetDir));

  let meta: WikiContractMetadata;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(
        'PARSE_ERROR',
        `${contractPath} is not a JSON object (parsed to ${parsed === null ? 'null' : typeof parsed})`,
      );
    }
    meta = parsed as WikiContractMetadata;
  } catch (err) {
    return fail('PARSE_ERROR', `Failed to parse ${contractPath}: ${String(err)}`, err);
  }

  if (dispatchInstalled(targetDir)) return ok(true);
  return ok(Array.isArray(meta.layers) && meta.layers.includes('planning'));
}

/**
 * Whether a manifest-declared install layer (WK-0261) is active, given the
 * resolved planning/dispatch flags for a target repo. The one evaluation rule
 * every surface reader (templates, required directories, skills, bootstrap-doc
 * spans) shares — no per-surface copy of this logic.
 */
export function layerActive(layer: ContractLayer, opts: { planning: boolean; dispatch: boolean }): boolean {
  if (layer === 'wiki') return true;
  if (layer === 'planning') return opts.planning;
  return opts.dispatch;
}

/** Assemble the managed-block body from sections, dropping inactive-layer sections. */
export function assembleBlockBody(
  sections: AgentInstructionsSection[],
  opts: { planning: boolean; dispatch: boolean },
): string {
  return sections
    .filter(section => {
      if (section.requires === 'dispatch') return opts.dispatch;
      if (section.requires === 'planning') return opts.planning;
      return true;
    })
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
  const body = assembleBlockBody(sections, { planning: true, dispatch: true });
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
