import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CreateHandoffOpts, CreateHandoffResult } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const KB_ROOT = resolve(THIS_DIR, '..', '..', '..');

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

async function nextHandoffId(handoffsDir: string): Promise<string> {
  let entries: string[] = [];
  try {
    entries = await readdir(handoffsDir);
  } catch {
    // handled by caller later on write
  }

  let max = 0;
  for (const entry of entries) {
    const match = entry.match(/^HO-(\d{4})\.md$/);
    if (!match) continue;
    max = Math.max(max, Number.parseInt(match[1]!, 10));
  }

  return `HO-${String(max + 1).padStart(4, '0')}`;
}

function renderHandoff(id: string, opts: CreateHandoffOpts): string {
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

export async function createHandoff(
  opts: CreateHandoffOpts,
): Promise<DispatchResult<CreateHandoffResult>> {
  const targetDir = resolve(opts.dir);
  const handoffsDir = join(targetDir, 'wiki', 'handoffs');
  const templateResult = await loadHandoffTemplate(targetDir);
  if (!templateResult.ok) return templateResult;

  const id = await nextHandoffId(handoffsDir);
  const handoffRelativePath = `wiki/handoffs/${id}.md`;
  const handoffPath = join(targetDir, handoffRelativePath);
  const content = renderHandoff(id, opts);

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
