import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardData, PlanItem } from './schema.js';
import { parseFrontmatter, parseFmArray, readWkRecord, readRecordMeta, findWkByInitiative, extractLinkedWkReferences, summarize, sourceLatestDate, buildDependencyDag, laneOf } from './util.js';

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

  // PLN nodes (WK-0084): ids referenced in this IN's own frontmatter arrays only -- there is
  // no "declared" or "body-linked" analog for PLN (that pattern is WK-specific, WK-0078).
  // A PLN ref with no record on disk is skipped gracefully, not an error.
  const planIds = ['related', 'depends_on', 'blocks']
    .flatMap(key => parseFmArray(content, key))
    .filter(ref => /^PLN-\d{4}$/.test(ref));
  const planItems = [...new Set(planIds)].sort()
    .map(planId => readPlanItem(repoRoot, planId))
    .filter(Boolean) as PlanItem[];

  return {
    record: { id, title: fm['title'] || id, status: fm['status'] || 'unknown', type: 'IN' },
    summary: summarize(workItems.map(w => w.lane)),
    phases: [],
    workItems,
    planItems,
    completedLog: [],
    failureLog: [],
    taskMatrix: null,
    dependencyDag: buildDependencyDag(workItems),
    dataDate: sourceLatestDate(content),
    source: `wiki/initiatives/${id}.md`,
  };
}

/** Reads a PLN record's title/status/lane + whether its dashboard HTML exists; null if the record is missing. */
function readPlanItem(repoRoot: string, planId: string): PlanItem | null {
  const meta = readRecordMeta(repoRoot, planId);
  if (!meta) return null;
  const dashboardPath = join(repoRoot, 'wiki', 'dashboard', `${planId}.html`);
  return {
    id: planId,
    title: meta.title,
    status: meta.status,
    lane: laneOf(meta.status, false),
    dashboardExists: existsSync(dashboardPath),
  };
}
