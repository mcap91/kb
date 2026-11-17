/**
 * Test helper: a work item with a one-row `## Slices` table. An implement
 * handoff is generated from a slice and admission refuses one whose row is
 * missing, so every fixture repo that dispatches or authors an implement
 * handoff carries one of these.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The id of the one slice row every fixture work item carries. */
export const SLICE_ID = 's1';

export interface SliceWorkItemOpts {
  /** The row's write_scope cell; entries are comma-separated in the table. */
  write_scope?: string[];
  /** The row's validation cell. */
  validation?: string;
  /** The row's title cell. */
  title?: string;
  /** The work item's `## Objective` text. */
  objective?: string;
  /** The work item's `## Acceptance criteria` items, one list item each. */
  acceptance?: string[];
  /** Extra body text appended after the Slices section (e.g. a drift marker). */
  extra?: string;
}

/** The `## Slices` section with the single row `SLICE_ID`. */
export function slicesSection(opts: SliceWorkItemOpts = {}): string {
  const scope = (opts.write_scope ?? ['src/a.ts']).join(', ');
  return [
    '## Slices',
    '',
    '| id | title | write_scope | depends_on | validation | status |',
    '|----|-------|-------------|------------|------------|--------|',
    `| ${SLICE_ID} | ${opts.title ?? 'Fixture slice'} | ${scope} | | ${opts.validation ?? 'npm test'} | todo |`,
    '',
  ].join('\n');
}

/** Markdown of a work item `id` whose Slices table has the single row `SLICE_ID`. */
export function sliceWorkItemText(id: string, opts: SliceWorkItemOpts = {}): string {
  return [
    '---',
    `id: "${id}"`,
    'title: "Fixture work item"',
    'type: feature',
    'status: todo',
    '---',
    '',
    `# ${id}: Fixture work item`,
    '',
    '## Objective',
    '',
    opts.objective ?? 'Make the fixture do the thing.',
    '',
    '## Acceptance criteria',
    '',
    ...(opts.acceptance ?? ['The thing is done']).map((item) => `- [ ] ${item}`),
    '',
    slicesSection(opts),
    ...(opts.extra === undefined ? [] : [opts.extra, '']),
  ].join('\n');
}

/** Write `wiki/issues/<id>.md` under `repoRoot` (or under `wikiDir` when the wiki root is elsewhere). */
export async function writeSliceWorkItem(
  repoRoot: string,
  id: string,
  opts: SliceWorkItemOpts & { wikiDir?: string } = {},
): Promise<string> {
  const path = join(opts.wikiDir ?? join(repoRoot, 'wiki'), 'issues', `${id}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sliceWorkItemText(id, opts), 'utf-8');
  return path;
}
