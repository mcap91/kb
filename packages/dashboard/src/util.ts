import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import dagre from 'dagre';
import type { WorkItem, Dependency, Lane, Summary, DependencyDag, DagNode, DagEdge } from './schema.js';

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
  if (block) return block[1].split('\n').map(l => l.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
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
  if (status === 'complete') return 'done';
  if (TERMINAL_STATUSES.has(status)) return 'done';
  if (status === 'in_progress' || status === 'review') {
    return hasUnmetDeps ? 'blocked' : 'in_progress';
  }
  if (status === 'blocked') return 'blocked';
  // 'not_started' and any other unknown status fall through to queued.
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

/**
 * WK ids whose own frontmatter declares `initiative: <inId>` (scans wiki/issues/*.md).
 * Deterministic directory read, sorted for stable output. Part of IN membership (WK-0078).
 */
export function findWkByInitiative(repoRoot: string, inId: string): string[] {
  const issuesDir = join(repoRoot, 'wiki', 'issues');
  if (!existsSync(issuesDir)) return [];
  const ids: string[] = [];
  for (const file of readdirSync(issuesDir)) {
    if (!file.endsWith('.md')) continue;
    const fm = parseFrontmatter(readFileSync(join(issuesDir, file), 'utf-8'));
    if (fm['initiative'] === inId) ids.push(file.replace(/\.md$/, ''));
  }
  return ids.sort();
}

/**
 * WK ids appearing as markdown links, e.g. `[WK-0072](...)`. Plain-text/backticked mentions
 * are intentionally excluded -- this is what keeps prose references (e.g. a cross-repo
 * "bioinfo `WK-0050`" mention) from being pulled in as IN members (WK-0078).
 */
export function extractLinkedWkReferences(content: string): string[] {
  const refs = new Set<string>();
  const regex = /\[(WK-\d{4})\]\([^)]*\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) refs.add(match[1]);
  return [...refs].sort();
}

export function buildDependencyDag(items: WorkItem[]): DependencyDag | null {
  if (items.length === 0) return null;

  const ids = new Set(items.map(w => w.id));
  const NODE_W = 160;
  const NODE_H = 40;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 16, ranksep: 40, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const w of items) {
    g.setNode(w.id, { width: NODE_W, height: NODE_H });
  }
  for (const w of items) {
    for (const dep of w.allDeps) {
      if (ids.has(dep)) g.setEdge(dep, w.id);
    }
  }

  dagre.layout(g);

  const graphInfo = g.graph();
  const nodes: DagNode[] = items.map(w => {
    const n = g.node(w.id);
    return {
      id: w.id,
      title: w.title,
      lane: w.lane,
      layer: 0,
      deps: w.allDeps.filter(d => ids.has(d)),
      x: n.x - NODE_W / 2,
      y: n.y - NODE_H / 2,
      width: NODE_W,
      height: NODE_H,
    };
  });

  const edges: DagEdge[] = g.edges().map(e => {
    const edge = g.edge(e);
    return { from: e.v, to: e.w, points: edge.points };
  });

  const maxLayer = 0;
  return {
    nodes,
    edges,
    width: graphInfo.width ?? 0,
    height: graphInfo.height ?? 0,
    maxLayer,
  };
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
