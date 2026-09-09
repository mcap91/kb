import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardData } from './schema.js';
import { parseFrontmatter, parseFmArray, readWkRecord, findWkByInitiative, extractLinkedWkReferences, summarize, sourceLatestDate, buildDependencyDag } from './util.js';

// Reads IN frontmatter + resolves linked WK records (status, lane, blocked-by).
export function parseInitiative(repoRoot: string, id: string): DashboardData {
  const inPath = join(repoRoot, 'wiki', 'initiatives', `${id}.md`);
  if (!existsSync(inPath)) {
    console.error(`Initiative not found: ${inPath}`);
    process.exit(1);
  }

  const content = readFileSync(inPath, 'utf-8');
  const fm = parseFrontmatter(content);

  // Membership = union of: (1) WK records that declare initiative: <id> in their own
  // frontmatter, (2) WK ids in this IN's frontmatter arrays, (3) WK ids markdown-linked
  // in the IN body. Plain-text/backticked mentions are NOT members -- keeps cross-repo
  // prose references out of the graph (WK-0078).
  const declared = findWkByInitiative(repoRoot, id);
  const arrayRefs = ['related', 'depends_on', 'blocks']
    .flatMap(key => parseFmArray(content, key))
    .filter(ref => /^WK-\d{4}$/.test(ref));
  const linked = extractLinkedWkReferences(content);
  const wkIds = [...new Set([...declared, ...arrayRefs, ...linked])].sort();

  const workItems = wkIds.map(wkId => readWkRecord(repoRoot, wkId)).filter(Boolean) as
    NonNullable<ReturnType<typeof readWkRecord>>[];

  return {
    record: { id, title: fm['title'] || id, status: fm['status'] || 'unknown', type: 'IN' },
    summary: summarize(workItems.map(w => w.lane)),
    phases: [],
    workItems,
    completedLog: [],
    failureLog: [],
    taskMatrix: null,
    dependencyDag: buildDependencyDag(workItems),
    dataDate: sourceLatestDate(content),
    source: `wiki/initiatives/${id}.md`,
  };
}
