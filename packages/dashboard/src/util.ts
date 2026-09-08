import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem, Dependency, Lane, Summary, DependencyDag, DagNode } from './schema.js';

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
  const inline = fm[1].match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
  if (inline) return inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const block = fm[1].match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm'));
  if (block) return block[1].split('\n').map(l => l.replace(/^\s+-\s+/, '').trim()).filter(Boolean);
  return [];
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

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'superseded', 'wont_do', 'duplicate', 'deprecated']);

/** Single source of truth for status -> lane. Explicit statuses are authoritative; unmet deps only block active work. */
export function laneOf(status: string, hasUnmetDeps: boolean): Lane {
  if (TERMINAL_STATUSES.has(status)) return 'done';
  if (status === 'in_progress' || status === 'active' || status === 'review') {
    return hasUnmetDeps ? 'blocked' : 'in_progress';
  }
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
  const allDeps = parseFmArray(content, 'depends_on');
  const resolved = resolveDependencies(repoRoot, allDeps);
  const blockedBy = resolved.filter(d => !d.met);
  const status = fm['status'] || 'unknown';
  const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)/);
  const body = bodyMatch ? bodyMatch[1].trim() : '';
  return {
    id,
    title: fm['title'] || id,
    status,
    lane: laneOf(status, blockedBy.length > 0),
    priority: fm['priority'] || '',
    blockedBy,
    allDeps,
    resolvedDeps: resolved,
    body,
  };
}

export function extractWkReferences(content: string): string[] {
  const refs = new Set<string>();
  const regex = /WK-\d{4}/g;
  let match;
  while ((match = regex.exec(content)) !== null) refs.add(match[0]);
  return [...refs].sort();
}

export function buildDependencyDag(items: WorkItem[]): DependencyDag | null {
  const ids = new Set(items.map(w => w.id));
  const hasAnyDeps = items.some(w => w.allDeps.some(d => ids.has(d)));
  if (!hasAnyDeps) return null;

  const layers = new Map<string, number>();
  function assignLayer(id: string, visited: Set<string>): number {
    if (layers.has(id)) return layers.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    const item = items.find(w => w.id === id);
    if (!item) { layers.set(id, 0); return 0; }
    const depLayers = item.allDeps.filter(d => ids.has(d)).map(d => assignLayer(d, visited));
    const layer = depLayers.length ? Math.max(...depLayers) + 1 : 0;
    layers.set(id, layer);
    return layer;
  }
  for (const w of items) assignLayer(w.id, new Set());

  const maxLayer = Math.max(...layers.values(), 0);
  const nodes: DagNode[] = items.map(w => ({
    id: w.id,
    title: w.title,
    lane: w.lane,
    layer: layers.get(w.id) || 0,
    deps: w.allDeps.filter(d => ids.has(d)),
  }));
  nodes.sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id));

  return { nodes, maxLayer };
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
