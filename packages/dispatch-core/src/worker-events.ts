/**
 * WK-0153 — worker event parsing: reads a run bundle's `worker-output.log`
 * and projects it into turn count, last activity, and files touched for
 * `status` enrichment of active (non-terminal) v2 runs.
 *
 * Three worker families write this file, each with a different shape
 * (SRC-0008 capture; pi's JSONL vocabulary confirmed directly against the
 * real fixture `tests/fixtures/pi-output-code-review.jsonl` — SRC-0008's own
 * closing note calling pi a "single JSON blob" does not match that capture
 * or `adapters/pi.ts`'s `parsePiOutput`, which has always read pi as
 * JSON-lines):
 *   - codex: streaming JSONL — one `turn.completed` per inference turn, one
 *     `item.completed` per finished item (commands, file changes, messages).
 *   - pi: streaming JSONL — one `turn_start` per inference turn. No
 *     `item.completed` concept and no `file_change` events — `message_end`
 *     is not counted as an item.
 *   - claude: a single buffered JSON object at exit (`{"type":"result",...}`),
 *     carrying `num_turns` but no incremental items or file changes.
 *
 * Never throws — malformed lines are silently skipped; a missing or empty
 * file returns the zero projection.
 */
import { readFile, stat } from 'node:fs/promises';

export interface WorkerEventProjection {
  turnCount: number;
  lastActivityAt: string | null; // ISO timestamp of last event, derived from file mtime
  filesTouched: string[]; // deduplicated repo-relative paths from file_change items (codex only)
  itemCount: number; // total item.completed events (codex only)
}

const EMPTY_PROJECTION: WorkerEventProjection = {
  turnCount: 0,
  lastActivityAt: null,
  filesTouched: [],
  itemCount: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readMtimeIso(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Codex's `file_change` items carry full absolute paths inside the
 * ephemeral clone (e.g. `/home/mcap91/.kb-dispatch/clones/RUN-xxx/src/file.txt`).
 * Strip everything up to and including the clone dir prefix so callers see
 * repo-relative paths. Paths that don't match the pattern pass through
 * unchanged rather than being dropped.
 */
function stripCloneDirPrefix(path: string): string {
  const marker = 'clones/RUN-';
  const markerIdx = path.indexOf(marker);
  if (markerIdx === -1) return path;
  const nextSlash = path.indexOf('/', markerIdx + marker.length);
  if (nextSlash === -1) return path;
  return path.slice(nextSlash + 1);
}

export async function parseWorkerEvents(workerOutputPath: string): Promise<WorkerEventProjection> {
  let raw: string;
  try {
    raw = await readFile(workerOutputPath, 'utf-8');
  } catch {
    return { ...EMPTY_PROJECTION };
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { ...EMPTY_PROJECTION };
  }

  // Claude: a single buffered JSON object at exit, not JSONL (SRC-0008).
  if (lines.length === 1) {
    let single: unknown;
    try {
      single = JSON.parse(lines[0]);
    } catch {
      single = undefined;
    }
    if (isRecord(single) && single.type === 'result') {
      const turnCount = typeof single.num_turns === 'number' ? single.num_turns : 0;
      const lastActivityAt = await readMtimeIso(workerOutputPath);
      return { turnCount, lastActivityAt, filesTouched: [], itemCount: 0 };
    }
  }

  // Otherwise: JSONL, one event per line — codex or pi.
  let turnCount = 0;
  let itemCount = 0;
  const filesTouched = new Set<string>();

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // malformed line — silently skipped
    }
    if (!isRecord(event)) continue;

    const type = event.type;

    // codex: `turn.completed` per inference turn. pi: `turn_start` per
    // inference turn (pi has no `turn.completed` equivalent).
    if (type === 'turn.completed' || type === 'turn_start') {
      turnCount++;
      continue;
    }

    // codex only: `item.completed` carries command/file_change/agent_message
    // items. Pi has no equivalent concept — its `message_end` is not an item.
    if (type === 'item.completed') {
      itemCount++;
      const item = event.item;
      if (isRecord(item) && item.type === 'file_change' && Array.isArray(item.changes)) {
        for (const change of item.changes) {
          if (isRecord(change) && typeof change.path === 'string') {
            filesTouched.add(stripCloneDirPrefix(change.path));
          }
        }
      }
    }
  }

  const lastActivityAt = await readMtimeIso(workerOutputPath);
  return { turnCount, lastActivityAt, filesTouched: [...filesTouched], itemCount };
}
