import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardData } from './schema.js';
import { readWkRecord, summarize, sourceLatestDate, buildDependencyDag } from './util.js';

// Reads a set of WK records and produces a status rollup with blocked-by resolution.
export function parseWkSet(repoRoot: string, ids: string[]): DashboardData {
  const workItems = ids
    .map(id => {
      const item = readWkRecord(repoRoot, id);
      if (!item) console.warn(`Warning: ${id} not found, skipping`);
      return item;
    })
    .filter(Boolean) as NonNullable<ReturnType<typeof readWkRecord>>[];

  const label = ids.length === 1 ? ids[0] : `from-${ids[0]}`;

  // dataDate = latest date across the set's source files (deterministic, no clock).
  const dates = workItems
    .map(w => {
      const p = join(repoRoot, 'wiki', 'issues', `${w.id}.md`);
      return existsSync(p) ? sourceLatestDate(readFileSync(p, 'utf-8')) : '';
    })
    .filter(Boolean)
    .sort();

  return {
    record: { id: label, title: `Work items: ${label} (${ids.length} records)`, status: '', type: 'WK-set' },
    summary: summarize(workItems.map(w => w.lane)),
    phases: [],
    workItems,
    completedLog: [],
    failureLog: [],
    taskMatrix: null,
    dependencyDag: buildDependencyDag(workItems),
    dataDate: dates.at(-1) || '',
    source: `wiki/issues/ (${ids.length} records)`,
  };
}

export function expandRange(rangeArg: string, repoRoot: string): string[] {
  const match = rangeArg.match(/^(WK)-(\d+)\.\.\1-(\d+)$/);
  if (!match) return [rangeArg];

  const start = parseInt(match[2], 10);
  const end = parseInt(match[3], 10);
  const issuesDir = join(repoRoot, 'wiki', 'issues');
  if (!existsSync(issuesDir)) return [];

  const files = new Set(readdirSync(issuesDir));
  const ids: string[] = [];
  for (let i = start; i <= end; i++) {
    const id = `WK-${String(i).padStart(4, '0')}`;
    if (files.has(`${id}.md`)) ids.push(id);
  }
  return ids;
}
