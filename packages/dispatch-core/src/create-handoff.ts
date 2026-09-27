import { execFile as execFileCb } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { allocate } from '@kb/wiki-core';

import type { CreateHandoffOpts, CreateHandoffResult } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
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
    ...listField('vars', opts.vars ?? []),
    ...(opts.reviewed_run ? [`reviewed_run: ${quote(opts.reviewed_run)}`] : []),
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

export async function createHandoff(
  opts: CreateHandoffOpts,
): Promise<DispatchResult<CreateHandoffResult>> {
  const workItemCheck = checkWorkItemForImplement(opts);
  if (!workItemCheck.ok) return workItemCheck;

  const targetDir = resolve(opts.dir);
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
