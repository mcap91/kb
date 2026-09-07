import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem, Dependency, Lane, Summary } from './schema.js';

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_]*):\s*"?([^"]*?)"?\s*$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

/**
 * Parse an inline YAML array from frontmatter, e.g. `depends_on: [WK-0074, WK-0075]`.
 * kb records use inline bracket arrays (verified across wiki/issues), so block-style
 * (`- item`) lists are intentionally not handled.
 */
export function parseFmArray(content: string, key: string): string[] {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const m = fm[1].match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
  if (!m) return [];
  return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

const RECORD_DIRS: Record<string, string> = { WK: 'issues', PLN: 'plans', IN: 'initiatives' };

function recordPath(repoRoot: string, id: string): string | null {
  const dir = RECORD_DIRS[id.split('-')[0]];
  if (!dir) return null;
  const p = join(repoRoot, 'wiki', dir, `${id}.md`);
  return existsSync(p) ? p : null;
}

export function readRecordMeta(repoRoot: string, id: string): { title: string; status: string } | null {
  const p = recordPath(repoRoot, id);
  if (!p) return null;
  const fm = parseFrontmatter(readFileSync(p, 'utf-8'));
  return { title: fm['title'] || id, status: fm['status'] || 'unknown' };
}

/** A dependency stops blocking once it reaches a terminal state. */
const MET_STATUSES = new Set(['done', 'cancelled', 'superseded', 'wont_do', 'duplicate', 'deprecated']);

export function isDependencyMet(status: string): boolean {
  return MET_STATUSES.has(status);
}

/** Single source of truth for status -> lane. An item with any unmet dependency is blocked. */
export function laneOf(status: string, hasUnmetDeps: boolean): Lane {
  if (hasUnmetDeps) return 'blocked';
  if (status === 'done') return 'done';
  if (status === 'in_progress' || status === 'active' || status === 'review') return 'in_progress';
  if (status === 'blocked') return 'blocked';
  return 'queued';
}

export function resolveDependencies(repoRoot: string, ids: string[]): Dependency[] {
  return ids.map(id => {
    const meta = readRecordMeta(repoRoot, id);
    const status = meta?.status || 'unknown';
    return { id, title: meta?.title || id, status, met: isDependencyMet(status) };
  });
}

export function readWkRecord(repoRoot: string, id: string): WorkItem | null {
  const path = join(repoRoot, 'wiki', 'issues', `${id}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  const fm = parseFrontmatter(content);
  const blockedBy = resolveDependencies(repoRoot, parseFmArray(content, 'depends_on')).filter(d => !d.met);
  const status = fm['status'] || 'unknown';
  return {
    id,
    title: fm['title'] || id,
    status,
    lane: laneOf(status, blockedBy.length > 0),
    priority: fm['priority'] || '',
    blockedBy,
  };
}

export function extractWkReferences(content: string): string[] {
  const refs = new Set<string>();
  const regex = /WK-\d{4}/g;
  let match;
  while ((match = regex.exec(content)) !== null) refs.add(match[0]);
  return [...refs].sort();
}

/** Latest YYYY-MM-DD present in the text; '' if none. Deterministic — no wall clock. */
export function sourceLatestDate(text: string): string {
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g);
  return dates ? dates.sort().at(-1)! : '';
}

/** Roll a list of lanes into counts for the summary tiles. */
export function summarize(lanes: Lane[]): Summary {
  const s: Summary = { done: 0, inProgress: 0, blocked: 0, queued: 0, total: lanes.length };
  for (const l of lanes) {
    if (l === 'done') s.done++;
    else if (l === 'in_progress') s.inProgress++;
    else if (l === 'blocked') s.blocked++;
    else s.queued++;
  }
  return s;
}
