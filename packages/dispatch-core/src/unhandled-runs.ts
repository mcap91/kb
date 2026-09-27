/**
 * WK-0153 — unhandled-runs reminder core query.
 *
 * Computes the list of finished-but-unhandled dispatch runs so callers (MCP
 * responses, CLI banners — wired up separately) can remind the operator of
 * completions they haven't acted on yet. Scans `.agent-runs/runs/` with the
 * same dual v1/v2 layout `status.ts` and `cleanup.ts` already read:
 *   - v2: `<runDir>/state.json` (schema_version 2, `completed_at` on the run root)
 *   - v1 (legacy): `<runDir>/metadata/meta.json` (`status` + `completed_at`;
 *     the v1 controller that wrote these was retired in WK-0134 — only
 *     historical run dirs use this path today)
 *
 * "Handled" is derived entirely from existing disk state (D2 ruling,
 * WK-0153): a review HO's `reviewed_run` stamp, or the run dir simply being
 * gone (cleanup). No new bookkeeping, no caching — every call re-scans.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

export interface UnhandledRun {
  handoff_id: string;
  run_id: string;
  status: string;
  branch: string;
  completed_at: string;
  note?: string;
}

/** Union of v2's and legacy v1's terminal status vocabularies (dispatch-controller-entry.ts's `V2RunStatus`; v1's `TerminalRunStatus` used `completed` where v2 uses `delivered`). Mirrors derive-review.ts's identical set. */
const V2_TERMINAL = new Set(['delivered', 'completed', 'failed', 'refused', 'timed_out', 'cancelled']);

/** Only these terminal outcomes can be discharged by review evidence — the rest nag until their run dir is cleaned up. */
const DISCHARGEABLE_BY_REVIEW = new Set(['delivered', 'completed']);

interface RunState {
  runId: string;
  status: string;
  completedAt: string;
  branch: string;
  unreadable: boolean;
  note?: string;
}

interface ReviewEvidenceEntry {
  reviewedRunId: string;
}

/**
 * Scan `wiki/handoffs/` for `code_review` HOs and index each one's discharge
 * evidence (`base_ref: dispatch/<handoff_id>` + `reviewed_run: <run id>`) by
 * the handoff id it targets. A review HO with no `reviewed_run` stamp (e.g.
 * one derived before this feature existed) contributes no evidence — it
 * discharges nothing (WK-0153 D2: "legacy review HOs without reviewed_run
 * discharge nothing").
 *
 * Deliberately a lightweight regex frontmatter read rather than `ho.ts`'s
 * `parseHandoff` — that parser requires a full HO record (title, write_scope,
 * non-empty acceptance/validation) and would reject a well-formed review HO
 * that happens to omit one of those, coupling this read to record shape it
 * doesn't need. Only `mode`, `base_ref`, and `reviewed_run` matter here.
 */
async function loadReviewEvidence(repoRoot: string): Promise<Map<string, ReviewEvidenceEntry>> {
  const evidence = new Map<string, ReviewEvidenceEntry>();
  const handoffsDir = join(repoRoot, 'wiki', 'handoffs');

  let files: string[];
  try {
    files = await readdir(handoffsDir);
  } catch {
    return evidence;
  }

  for (const file of files) {
    if (!file.startsWith('HO-') || !file.endsWith('.md') || file.endsWith('.response.md')) {
      continue;
    }

    try {
      const content = await readFile(join(handoffsDir, file), 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1] ?? '';

      const modeMatch = fm.match(/^mode:\s*(.+)$/m);
      if (!modeMatch || modeMatch[1].trim() !== 'code_review') continue;

      const baseRefMatch = fm.match(/^base_ref:\s*"?([^"\n]+)"?$/m);
      if (!baseRefMatch) continue;

      const baseRef = baseRefMatch[1].trim();
      const hoMatch = baseRef.match(/^dispatch\/(HO-\d+)$/);
      if (!hoMatch) continue;
      const targetHandoffId = hoMatch[1];

      const reviewedRunMatch = fm.match(/^reviewed_run:\s*"?([^"\n]+)"?$/m);
      if (!reviewedRunMatch) continue;
      const reviewedRunId = reviewedRunMatch[1].trim();

      if (targetHandoffId) {
        evidence.set(targetHandoffId, { reviewedRunId });
      }
    } catch {
      // Skip unreadable handoff files.
    }
  }

  return evidence;
}

/** Read a single run dir's status/completed_at/branch, trying v2's root `state.json` then falling back to v1's `metadata/meta.json`. Never throws — an unreadable run dir is reported via the `unreadable` flag, not an exception. */
async function readRunState(runDir: string): Promise<Omit<RunState, 'runId'>> {
  let status = '';
  let completedAt = '';
  let branch = '';
  let unreadable = false;
  let note: string | undefined;

  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;
    if (state.schema_version === 2) {
      status = typeof state.status === 'string' ? state.status : '';
      completedAt = typeof state.completed_at === 'string' ? state.completed_at : '';
      branch = typeof state.branch === 'string' ? state.branch : '';
    } else {
      throw new Error('not v2');
    }
  } catch {
    try {
      const raw = await readFile(join(runDir, 'metadata', 'meta.json'), 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      status = typeof meta.status === 'string' ? meta.status : '';
      completedAt = typeof meta.completed_at === 'string' ? meta.completed_at : '';
    } catch {
      unreadable = true;
      note = `state.json and metadata/meta.json both unreadable in ${runDir}`;
    }
  }

  return { status, completedAt, branch, unreadable, note };
}

export async function listUnhandledRuns(repoRoot: string): Promise<DispatchResult<UnhandledRun[]>> {
  try {
    const runsDir = join(repoRoot, '.agent-runs', 'runs');
    let handoffDirs: string[];
    try {
      handoffDirs = await readdir(runsDir);
    } catch {
      return ok([]);
    }

    const handoffRuns = new Map<string, RunState[]>();

    for (const handoffId of handoffDirs) {
      let runIds: string[];
      try {
        runIds = await readdir(join(runsDir, handoffId));
      } catch {
        continue;
      }

      const runs: RunState[] = [];
      for (const runId of runIds) {
        const runDir = join(runsDir, handoffId, runId);
        const state = await readRunState(runDir);
        // All runs of an HO share one delivery branch (WK-0153) — default to
        // it when the run's own record carries none (v1 runs, or a v2
        // no-op/failed outcome that never created a branch).
        const branch = state.branch || `dispatch/${handoffId}`;
        runs.push({ ...state, runId, branch });
      }

      if (runs.length > 0) {
        handoffRuns.set(handoffId, runs);
      }
    }

    const reviewEvidence = await loadReviewEvidence(repoRoot);

    const unhandled: UnhandledRun[] = [];

    for (const [handoffId, runs] of handoffRuns) {
      // An in-flight retry of the same HO suppresses its terminal sibling's
      // line (WK-0153 D2 concurrency note) — it is already visible via
      // `status`, and "latest terminal run" moves automatically once the
      // retry itself reaches a terminal state.
      const hasNonTerminal = runs.some((r) => !r.unreadable && !V2_TERMINAL.has(r.status) && r.status !== '');

      const terminalRuns = runs.filter((r) => !r.unreadable && V2_TERMINAL.has(r.status));
      terminalRuns.sort((a, b) => {
        const cmp = b.completedAt.localeCompare(a.completedAt);
        return cmp !== 0 ? cmp : b.runId.localeCompare(a.runId);
      });
      const latestTerminal = terminalRuns[0];

      // Unreadable run dirs are always surfaced, regardless of what else is
      // happening for this HO — fail loud, never silently skipped.
      for (const ur of runs.filter((r) => r.unreadable)) {
        unhandled.push({
          handoff_id: handoffId,
          run_id: ur.runId,
          status: 'unreadable',
          branch: `dispatch/${handoffId}`,
          completed_at: '',
          note: ur.note,
        });
      }

      if (!latestTerminal) continue;
      if (hasNonTerminal) continue;

      if (DISCHARGEABLE_BY_REVIEW.has(latestTerminal.status)) {
        const evidence = reviewEvidence.get(handoffId);
        if (evidence && evidence.reviewedRunId === latestTerminal.runId) {
          continue; // Discharged by a matching review HO.
        }
      }
      // failed/refused/cancelled/timed_out: never discharged by review —
      // only cleanup removing the run dir clears these.

      unhandled.push({
        handoff_id: handoffId,
        run_id: latestTerminal.runId,
        status: latestTerminal.status,
        branch: latestTerminal.branch,
        completed_at: latestTerminal.completedAt,
      });
    }

    return ok(unhandled);
  } catch (err) {
    return fail('STATUS_ERROR', 'Failed to list unhandled runs.', err);
  }
}
