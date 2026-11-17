import { execFile as execFileCb } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { allocate, readSection, readSlices } from '@kb/wiki-core';

import type { CreateHandoffInput, CreateHandoffOpts, CreateHandoffResult } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { checkWriteScopeEntryShape, readFirstEntryExists } from './admission.js';
import { probeWikiSource } from './wiki-source.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const KB_ROOT = resolve(THIS_DIR, '..', '..', '..');
const execFile = promisify(execFileCb);

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function listBlock(values: string[]): string[] {
  if (values.length === 0) {
    return ['[]'];
  }
  return ['', ...values.map((value) => `  - ${value}`)];
}

function writeScopeBlock(values: string[]): string[] {
  if (values.length === 0) {
    return ['write_scope: []'];
  }
  return ['write_scope:', ...values.map((value) => `  - ${value}`)];
}

function scalarField(name: string, value?: string): string {
  if (!value) return `${name}:`;
  return `${name}: ${quote(value)}`;
}

function listField(name: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`${name}: []`];
  }
  return [`${name}:`, ...values.map((value) => `  - ${value}`)];
}

async function loadHandoffTemplate(targetDir: string): Promise<DispatchResult<string>> {
  const repoTemplatePath = join(targetDir, 'wiki', 'templates', 'handoff.md');
  try {
    return ok(await readFile(repoTemplatePath, 'utf-8'));
  } catch {
    const fallback = join(KB_ROOT, 'contract', 'templates', 'handoff.md');
    try {
      return ok(await readFile(fallback, 'utf-8'));
    } catch {
      return fail('NOT_BOOTSTRAPPED', `Handoff template not found in ${repoTemplatePath}. Bootstrap the repo first.`);
    }
  }
}

/** WK-0152 authoring-time stamps; empty for chained HOs (base_ref set). */
export interface HandoffStamps {
  base_sha?: string;
  base_wiki_sha?: string;
}

/**
 * WK-0152: a fresh-HEAD HO (no base_ref) is stamped with the commit(s) it was
 * written against, so admission's base-drift gate can tell whether its
 * declared files changed before dispatch. Chained HOs run on an immutable
 * dispatch/ branch and get no stamp.
 */
async function resolveStamps(targetDir: string, opts: CreateHandoffOpts): Promise<DispatchResult<HandoffStamps>> {
  if (opts.base_ref) return ok({});

  let baseSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: targetDir });
    baseSha = stdout.trim();
  } catch (err) {
    return fail(
      'LOOKUP_FAILED',
      `Failed to resolve HEAD in ${targetDir}; a handoff without base_ref must be stamped with base_sha (WK-0152).`,
      err,
    );
  }

  const wiki = await probeWikiSource(targetDir);
  if (!wiki.ok) return wiki;
  return ok(wiki.data.head === null ? { base_sha: baseSha } : { base_sha: baseSha, base_wiki_sha: wiki.data.head });
}

export function renderHandoff(id: string, opts: CreateHandoffOpts, stamps: HandoffStamps = {}): string {
  const now = new Date().toISOString();
  const lines = [
    '---',
    'schema_version: 1',
    `id: ${quote(id)}`,
    `title: ${quote(opts.title)}`,
    `subject: ${quote(opts.subject)}`,
    'allowed_agents:',
    ...opts.allowed_agents.map((agent) => `  - ${agent}`),
    `mode: ${opts.mode}`,
    `status: ${opts.status ?? 'draft'}`,
    `created: ${quote(now)}`,
    `updated: ${quote(now)}`,
    ...listField('depends_on', opts.depends_on ?? []),
    scalarField('area', opts.area),
    scalarField('initiative', opts.initiative),
    scalarField('work_item', opts.work_item),
    ...(opts.slice ? [scalarField('slice', opts.slice)] : []),
    ...writeScopeBlock(opts.write_scope ?? []),
    ...listField('read_first', opts.read_first ?? []),
    ...listField('acceptance', opts.acceptance),
    ...listField('validation', opts.validation),
    scalarField('base_ref', opts.base_ref ?? ''),
    scalarField('base_sha', stamps.base_sha),
    ...(stamps.base_wiki_sha ? [scalarField('base_wiki_sha', stamps.base_wiki_sha)] : []),
    `web: ${opts.web ?? false}`,
    ...listField('credentials', opts.credentials ?? []),
    ...listField('data_mounts', opts.data_mounts ?? []),
    ...listField('export_mounts', opts.export_mounts ?? []),
    ...listField('runtime_envs', opts.runtime_envs ?? []),
    ...listField('vars', opts.vars ?? []),
    ...(opts.reviewed_run ? [`reviewed_run: ${quote(opts.reviewed_run)}`] : []),
    ...(opts.reviewed_sha ? [`reviewed_sha: ${quote(opts.reviewed_sha)}`] : []),
    '---',
    '',
    `# ${id}: ${opts.title}`,
    '',
    '## Read First',
    ...(opts.read_first && opts.read_first.length > 0
      ? opts.read_first.map((value) => `- ${value}`)
      : []),
    '',
    '## Objective',
    opts.objective ?? '',
    '',
    '## Constraints',
    ...(opts.constraints && opts.constraints.length > 0
      ? opts.constraints.map((value) => `- ${value}`)
      : []),
    '',
    '## Expected Output',
    opts.expected_output ?? '',
    '',
    '## Context',
    opts.context ?? '',
    '',
  ];

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * WK-0120: mirrors admission.ts's `checkWorkItemExists` gate at authoring
 * time. An implement-mode HO with no (or malformed) work_item would pass
 * authoring only to be refused later at dispatch with WORK_ITEM_NOT_FOUND
 * (WK-0116; narrowed by DEC-0036 WK-0121) — refuse here instead, before a
 * broken HO ever hits disk. Non-implement modes (code_review, redteam) stay
 * work_item-optional (DEC-0035).
 */
function checkWorkItemForImplement(opts: CreateHandoffOpts): DispatchResult<null> {
  if (opts.mode !== 'implement') return ok(null);

  const workItem = opts.work_item;
  if (workItem === undefined || workItem.trim() === '' || !/^WK-\d{4}$/.test(workItem)) {
    return fail(
      'MISSING_FIELD',
      'mode=implement requires work_item matching /^WK-\\d{4}$/; without it, dispatch refuses with WORK_ITEM_NOT_FOUND.',
    );
  }

  return ok(null);
}

/**
 * Refuses to author an HO whose write_scope entry fails the shared
 * entry-shape rule (`checkWriteScopeEntryShape`, admission.ts) — the same
 * `.git`-segment / root-aliasing refusal admission applies at dispatch time,
 * now also enforced at authoring time so a broken HO never even reaches
 * disk. Every family: the refusal names only the rule, never another
 * family.
 */
async function checkWriteScopeEntriesForAuthoring(targetDir: string, writeScope: string[]): Promise<DispatchResult<null>> {
  for (const entry of writeScope) {
    const shapeCheck = await checkWriteScopeEntryShape(targetDir, entry);
    if (!shapeCheck.ok) return shapeCheck;
  }
  return ok(null);
}

/** Checklist items (`- [ ] text`, `- [x] text`, `- text`) of a WK section, marker stripped. */
function listItems(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (match) items.push(match[1]);
  }
  return items;
}

const SLICE_DERIVED_FIELDS = ['write_scope', 'read_first', 'objective', 'acceptance', 'validation'] as const;

/**
 * Resolves `wk` + `slice` into full explicit options: `write_scope` and
 * `validation` from the slice row, `read_first` = the row's files that exist
 * now (a new slice's files do not exist yet and admission refuses a missing
 * read_first path) plus the WK path, `objective` and `acceptance` from the WK
 * body. Supplying any derived field alongside a slice is refused, never merged.
 */
async function resolveSliceOpts(input: CreateHandoffInput, targetDir: string): Promise<DispatchResult<CreateHandoffOpts>> {
  const { wk, slice } = input;
  if (!wk || !slice) {
    return fail('MISSING_FIELD', 'wk and slice must be given together; use work_item and explicit fields for a work item with no Slices table.');
  }
  if (!/^WK-\d{4}$/.test(wk)) {
    return fail('MISSING_FIELD', `wk must match /^WK-\\d{4}$/; got: ${wk}`);
  }
  const conflicts = SLICE_DERIVED_FIELDS.filter((field) => {
    const value = input[field];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
  if (conflicts.length > 0) {
    return fail('INVALID_HANDOFF', `${conflicts.join(', ')} derive from slice ${slice} of ${wk} and cannot be given alongside it.`);
  }

  const wkRelativePath = `wiki/issues/${wk}.md`;
  let wkText: string;
  try {
    wkText = await readFile(join(targetDir, wkRelativePath), 'utf-8');
  } catch (err) {
    return fail('FILE_NOT_FOUND', `Work item ${wkRelativePath} not found in ${targetDir}.`, err);
  }

  const slices = readSlices(wkText);
  if (!slices.ok) return fail('PARSE_ERROR', `${wkRelativePath}: ${slices.message}`, slices);
  if (slices.data.length === 0) {
    return fail('MISSING_FIELD', `${wk} has no "## Slices" table; use work_item and explicit fields instead of wk and slice.`);
  }
  const row = slices.data.find((candidate) => candidate.id === slice);
  if (!row) {
    return fail('MISSING_FIELD', `${wk} has no slice "${slice}"; its slices are: ${slices.data.map((candidate) => candidate.id).join(', ')}.`);
  }

  const acceptance = listItems(readSection(wkText, 'Acceptance criteria') ?? '');
  if (acceptance.length === 0) {
    return fail('MISSING_FIELD', `${wkRelativePath} has no "## Acceptance criteria" items to derive acceptance from.`);
  }
  if (row.validation === '') {
    return fail('MISSING_FIELD', `Slice ${slice} of ${wk} has an empty validation cell.`);
  }

  const existing: string[] = [];
  for (const file of row.write_scope) {
    if (await readFirstEntryExists(file, input.base_ref ?? null, targetDir)) existing.push(file);
  }

  return ok({
    ...input,
    title: input.title ?? row.title,
    mode: input.mode ?? 'implement',
    work_item: wk,
    slice,
    write_scope: row.write_scope,
    read_first: [...existing, wkRelativePath],
    objective: readSection(wkText, 'Objective') ?? '',
    acceptance,
    validation: [row.validation],
  });
}

/** Explicit path: the fields the slice path derives must all be present. */
function requireExplicitFields(input: CreateHandoffInput): DispatchResult<CreateHandoffOpts> {
  const { title, mode, acceptance, validation } = input;
  if (title === undefined || mode === undefined || acceptance === undefined || validation === undefined) {
    return fail('MISSING_FIELD', 'title, mode, acceptance and validation are required unless wk and slice are given.');
  }
  return ok({ ...input, title, mode, acceptance, validation });
}

export async function createHandoff(
  input: CreateHandoffInput,
): Promise<DispatchResult<CreateHandoffResult>> {
  const targetDir = resolve(input.dir);
  const resolved = input.wk !== undefined || input.slice !== undefined
    ? await resolveSliceOpts(input, targetDir)
    : requireExplicitFields(input);
  if (!resolved.ok) return resolved;
  const opts = resolved.data;

  const workItemCheck = checkWorkItemForImplement(opts);
  if (!workItemCheck.ok) return workItemCheck;

  const writeScopeCheck = await checkWriteScopeEntriesForAuthoring(targetDir, opts.write_scope ?? []);
  if (!writeScopeCheck.ok) return writeScopeCheck;

  const templateResult = await loadHandoffTemplate(targetDir);
  if (!templateResult.ok) return templateResult;

  const stampsResult = await resolveStamps(targetDir, opts);
  if (!stampsResult.ok) return stampsResult;

  const allocResult = await allocate({ dir: targetDir, prefix: 'HO' });
  if (!allocResult.ok) return fail('ALLOCATION_FAILED', allocResult.message);
  const id = allocResult.data.id;
  const handoffRelativePath = `wiki/handoffs/${id}.md`;
  const handoffPath = join(targetDir, handoffRelativePath);
  const content = renderHandoff(id, opts, stampsResult.data);

  try {
    await writeFile(handoffPath, content, 'utf-8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write handoff at ${handoffPath}.`, err);
  }

  return ok({
    handoffId: id,
    handoffPath,
    handoffRelativePath,
  });
}
