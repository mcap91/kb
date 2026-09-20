/**
 * Dependency-readiness projection (WK-0115).
 *
 * Deliberately pure, synchronous, IO-free — reads only the fields passed in on `nodes`,
 * never the filesystem. Design-mirror only (ELv2) of upstream's
 * `work-record-dispatch-slice-dag.mjs` (`buildSliceDagProjection`): ready/blocked/done
 * split, blocked-by taxonomy, and WHITE/GRAY/BLACK cycle detection, adapted to kb's
 * WK/IN status enum. Callers (lint, dispatch, the dashboard) pass already-parsed nodes.
 */

/** Minimal per-record shape this module needs; extra frontmatter fields are the caller's concern. */
export interface DependencyNode {
  id: string;
  status: string;
  depends_on: string[];
  blocks: string[];
}

/**
 * Why a `depends_on` edge fails to satisfy readiness.
 *   - unsatisfied         — the dependency exists but has not reached a satisfied status
 *   - terminal_predecessor — the dependency is in a terminal status that can never
 *                            become satisfied (cancelled/superseded/wont_do/duplicate/deprecated)
 *   - missing_target      — the dependency id does not resolve to any known node
 */
export type BlockedByReason = 'unsatisfied' | 'terminal_predecessor' | 'missing_target';

export interface BlockedBy {
  id: string;
  reason: BlockedByReason;
}

export type DependencyState = 'ready' | 'blocked' | 'done';

export interface DependencyProjectionNode {
  id: string;
  status: string;
  state: DependencyState;
  blocked_by: BlockedBy[];
}

/** A non-fatal structural finding surfaced alongside the projection (currently: cycles). */
export interface DependencyDiagnostic {
  code: string;
  message: string;
  ids: string[];
}

export interface DependencyProjection {
  nodes: DependencyProjectionNode[];
  frontier: string[];
  blocked: string[];
  done: string[];
  diagnostics: DependencyDiagnostic[];
}

export interface BuildDependencyProjectionOpts {
  /** Statuses that satisfy a dependency edge. Default: strict done-only (the canonical
   *  readiness gate for lint/dispatch consumers). Callers with a lenient display bucket
   *  (e.g. the dashboard) may widen this — it never changes the shared algorithm. */
  satisfiedStatuses?: Set<string>;
}

const DEFAULT_SATISFIED_STATUSES = new Set(['done']);

/**
 * Statuses a predecessor can never leave. A dependent on one of these can never become
 * satisfied through it (unless the caller's `satisfiedStatuses` already covers it — see
 * the satisfied-status check that runs before this one).
 */
const TERMINAL_PREDECESSOR_STATUSES = new Set([
  'cancelled',
  'superseded',
  'wont_do',
  'duplicate',
  'deprecated',
]);

/**
 * Detect cycles in `depends_on` edges via WHITE/GRAY/BLACK DFS, restricted to ids present
 * in `nodes` — a dangling reference is a `missing_target` blocked-by reason (computed
 * separately below), never a cycle participant. One diagnostic is emitted per back-edge
 * found; `ids` lists every node on the cyclic path (the current DFS stack from the
 * back-edge's target through to the node that closed the cycle).
 */
function detectCycles(
  nodes: DependencyNode[],
): { cycleMembers: Set<string>; diagnostics: DependencyDiagnostic[] } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const stack: string[] = [];
  const cycleMembers = new Set<string>();
  const diagnostics: DependencyDiagnostic[] = [];

  function visit(id: string): void {
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id);
    for (const depId of node?.depends_on ?? []) {
      if (!byId.has(depId)) continue; // missing target — not a cycle participant
      const depColor = color.get(depId);
      if (depColor === WHITE) {
        visit(depId);
      } else if (depColor === GRAY) {
        // Back edge: depId is an ancestor still on the stack -> everything from
        // depId's position to the top of the stack forms a cycle.
        const idx = stack.indexOf(depId);
        const members = stack.slice(idx);
        for (const m of members) cycleMembers.add(m);
        diagnostics.push({
          code: 'cycle',
          message: `Dependency cycle detected: ${members.join(' -> ')} -> ${depId}`,
          ids: [...members],
        });
      }
      // BLACK: already fully explored outside the current path — not a cycle.
    }
    stack.pop();
    color.set(id, BLACK);
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) visit(n.id);
  }

  return { cycleMembers, diagnostics };
}

/**
 * Compute per-node ready/blocked/done state from `depends_on` edges, plus structural
 * cycle detection.
 *
 * Split: `done` if status is in `satisfiedStatuses`; else `blocked` if any dependency
 * edge is unsatisfied; else `ready`. Cycle members always end up `blocked` (with a
 * `code: 'cycle'` diagnostic), even if their own status would otherwise read as `done` —
 * a structural cycle is never actually resolvable.
 */
export function buildDependencyProjection(
  nodes: DependencyNode[],
  opts?: BuildDependencyProjectionOpts,
): DependencyProjection {
  const satisfiedStatuses = opts?.satisfiedStatuses ?? DEFAULT_SATISFIED_STATUSES;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const { cycleMembers, diagnostics } = detectCycles(nodes);

  const outNodes: DependencyProjectionNode[] = nodes.map(n => {
    if (satisfiedStatuses.has(n.status)) {
      const state: DependencyState = cycleMembers.has(n.id) ? 'blocked' : 'done';
      return { id: n.id, status: n.status, state, blocked_by: [] };
    }

    const blockedBy: BlockedBy[] = [];
    for (const depId of n.depends_on ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        blockedBy.push({ id: depId, reason: 'missing_target' });
      } else if (satisfiedStatuses.has(dep.status)) {
        // Satisfied — does not block.
      } else if (TERMINAL_PREDECESSOR_STATUSES.has(dep.status)) {
        blockedBy.push({ id: depId, reason: 'terminal_predecessor' });
      } else {
        blockedBy.push({ id: depId, reason: 'unsatisfied' });
      }
    }

    const state: DependencyState =
      cycleMembers.has(n.id) || blockedBy.length > 0 ? 'blocked' : 'ready';
    return { id: n.id, status: n.status, state, blocked_by: blockedBy };
  });

  const frontier = outNodes.filter(n => n.state === 'ready').map(n => n.id);
  const blocked = outNodes.filter(n => n.state === 'blocked').map(n => n.id);
  const done = outNodes.filter(n => n.state === 'done').map(n => n.id);

  return { nodes: outNodes, frontier, blocked, done, diagnostics };
}
