import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardData } from './schema.js';
import { parseFrontmatter, readWkRecord, extractWkReferences, summarize, sourceLatestDate } from './util.js';

// Reads IN frontmatter + resolves linked WK records (status, lane, blocked-by).
export function parseInitiative(repoRoot: string, id: string): DashboardData {
  const inPath = join(repoRoot, 'wiki', 'initiatives', `${id}.md`);
  if (!existsSync(inPath)) {
    console.error(`Initiative not found: ${inPath}`);
    process.exit(1);
  }

  const content = readFileSync(inPath, 'utf-8');
  const fm = parseFrontmatter(content);
  const wkIds = extractWkReferences(content);
  const workItems = wkIds.map(wkId => readWkRecord(repoRoot, wkId)).filter(Boolean) as
    NonNullable<ReturnType<typeof readWkRecord>>[];

  return {
    record: { id, title: fm['title'] || id, status: fm['status'] || 'unknown', type: 'IN' },
    summary: summarize(workItems.map(w => w.lane)),
    phases: [],
    workItems,
    completedLog: [],
    failureLog: [],
    dataDate: sourceLatestDate(content),
    source: `wiki/initiatives/${id}.md`,
  };
}
