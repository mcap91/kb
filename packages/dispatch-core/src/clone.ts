/**
 * Ephemeral clone management (spec §8; WK-0074 B4R proven; T5 S0 slice).
 *
 * Every implement run executes in an ephemeral FULL clone at a pinned `base_sha`
 * (spec §8, decision R2/R5: the mother repo is read-only to dispatch; clone root is
 * dispatch-owned, disk-backed, and NEVER `/tmp` — tmpfs would put node_modules in
 * RAM/vmmem). On the Windows tier the mother repo lives on NTFS and the clone lands
 * on WSL2 ext4 at `~/.kb-dispatch/clones/<run>` (measured: clone-in 1.06s, push-back
 * 161ms — WK-0074 GATE 2 B10/B11). This module only knows how to create, remove, and
 * sweep those clones; the delivery/plumbing-commit path (§8 canonical delivery
 * sequence) is a separate module (delivery.ts, Wave 2b).
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';
import { execViaWsl2, windowsToWslPath } from './wsl2.js';

export interface CloneOpts {
  /** Absolute Windows path to the mother repo. */
  motherRepo: string;
  /** Run ID (used to name the clone dir). */
  runId: string;
  /** base_sha to checkout in the clone. */
  baseSha: string;
  /** The WSL2 clone root (default: ~/.kb-dispatch/clones). */
  cloneRoot?: string;
}

export interface CloneResult {
  /** WSL2 path to the clone directory. */
  clonePath: string;
  /** The actual base_sha checked out. */
  baseSha: string;
}

// New v2 error code produced by this module; will be merged into the shared
// DispatchErrorCode union in errors.ts at wave-3 integration. errors.ts is not
// modified by this file (wave-2 constraint).
type CloneErrorCode = 'CLONE_FAILED';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'CLONE_FAILED' as CloneErrorCode, message, detail } as unknown as DispatchResult<T>;
}

const DEFAULT_CLONE_ROOT = '~/.kb-dispatch/clones';
// 24h — best-effort orphan sweep (spec §8 decision R5), not a hard guarantee.
const ORPHAN_THRESHOLD_SECONDS = 24 * 60 * 60;

// removeClone hardening (mid_project_review_rulings.md ruling 6, "Ruling 6 —
// D2-remainder"; D6 component 12). The one canonical clone root every real
// run uses — removeClone refuses to delete anything whose resolved (symlink-
// followed) parent directory isn't exactly this. Threat surface is small:
// clonePath is a `const` pipeline.ts builds from CLONE_ROOT + a server-
// generated `RUN-${randomUUID()}` (pipeline.ts:195-196, regex-locked at
// createClone) — never LLM-influenced, never exposed on an MCP tool schema,
// never reassigned. This is defense-in-depth against a bug in kb's own code,
// not adversarial input.
const CANONICAL_CLONE_ROOT = join(homedir(), '.kb-dispatch', 'clones');
const RUN_ID_BASENAME_PATTERN = /^RUN-/;

// runId / baseSha are interpolated directly into a generated bash script (WSL2
// scripts are files, not shell-escaped argv — spec §11), so both are restricted to a
// safe ref/identifier charset before they ever reach script text.
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** Rewrite a leading `~/` to `$HOME/` so the path expands correctly even when the
 * generated script double-quotes it (bare `~` does not expand inside double quotes,
 * but `$HOME` does). */
function toShellPath(path: string): string {
  return path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path;
}

async function withTempRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-dispatch-clone-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildCloneScript(motherRepoWsl: string, cloneRootShell: string, runId: string, baseSha: string): string {
  // Every git invocation here is a fresh clone under dispatch's own clone root
  // (never the mother repo), so the frozen delivery config (§8 canonical sequence)
  // does not apply — that config guards the plumbing-commit/push-back path in
  // delivery.ts, not this read-only clone-in step. git's own chatter is redirected to
  // stderr so this script's stdout carries exactly the two facts the caller needs.
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `CLONE_ROOT="${cloneRootShell}"`,
    `CLONE_DIR="$CLONE_ROOT/${runId}"`,
    'mkdir -p "$CLONE_ROOT"',
    `git clone "${motherRepoWsl}" "$CLONE_DIR" >&2`,
    'cd "$CLONE_DIR"',
    `git checkout "${baseSha}" >&2`,
    'echo "$CLONE_DIR"',
    'git rev-parse HEAD',
    '',
  ].join('\n');
}

/**
 * Create an ephemeral full clone of the mother repo at a pinned `base_sha`, inside
 * WSL2 on the dispatch-owned clone root. Steps (spec §8 step 2 / WK-0074 B10):
 * resolve the clone root, `mkdir -p` it, `git clone` the mother repo (Windows path
 * converted to its `/mnt/c/...` WSL2 equivalent), `git checkout base_sha` inside the
 * clone. The clone directory and the resolved HEAD sha are read back off the
 * script's stdout rather than assumed, since `base_sha` may be a symbolic ref.
 */
export async function createClone(opts: CloneOpts): Promise<DispatchResult<CloneResult>> {
  if (!opts.motherRepo.trim()) {
    return fail('Refusing to clone: motherRepo is empty.');
  }
  if (!SAFE_REF_PATTERN.test(opts.runId)) {
    return fail('Refusing to clone: runId contains unsafe characters.', { runId: opts.runId });
  }
  if (!SAFE_REF_PATTERN.test(opts.baseSha)) {
    return fail('Refusing to clone: baseSha contains unsafe characters.', { baseSha: opts.baseSha });
  }

  const cloneRoot = opts.cloneRoot ?? DEFAULT_CLONE_ROOT;
  const motherRepoWsl = windowsToWslPath(opts.motherRepo);
  const scriptContent = buildCloneScript(motherRepoWsl, toShellPath(cloneRoot), opts.runId, opts.baseSha);

  return withTempRunDir(async (runDir) => {
    const execResult = await execViaWsl2({ runDir, scriptContent, scriptName: 'clone.sh' });
    if (!execResult.ok) return execResult;

    if (execResult.data.exitCode !== 0) {
      return fail(
        `Clone script exited with code ${execResult.data.exitCode} for run ${opts.runId}.`,
        execResult.data,
      );
    }

    const lines = execResult.data.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const clonePath = lines[0];
    const resolvedBaseSha = lines[1] ?? opts.baseSha;

    if (!clonePath) {
      return fail('Clone script produced no clone path on stdout.', execResult.data);
    }

    return ok({ clonePath, baseSha: resolvedBaseSha });
  });
}

/**
 * Structural guard over an already-resolved (symlink-followed) clone path:
 * does it look like a genuine dispatch-owned clone directory? Pure and
 * exported separately from `removeClone` so the check itself is unit-testable
 * without touching the filesystem (ruling 6's four checks, minus the
 * `realpath` step which necessarily needs the real filesystem).
 *
 * Three checks, run in order:
 * 1. parent directory equals the canonical clone root exactly
 * 2. basename matches `^RUN-`
 * 3. the runId (basename minus the `RUN-` prefix) contains no `/` or `..`
 *
 * The third check is defense-in-depth on top of the first two: `dirname`/
 * `basename` on an already-realpath'd input can't smuggle a traversal by
 * construction, but a literal (non-traversing) `..` substring inside the id
 * itself — e.g. a directory genuinely named `RUN-..evil` — would still pass
 * checks 1-2, so it's rejected explicitly here rather than assumed away.
 */
function checkClonePathStructure(resolvedPath: string): { safe: true } | { safe: false; reason: string } {
  const parent = dirname(resolvedPath);
  if (parent !== CANONICAL_CLONE_ROOT) {
    return { safe: false, reason: `parent directory "${parent}" is not the canonical clone root "${CANONICAL_CLONE_ROOT}"` };
  }

  const base = basename(resolvedPath);
  if (!RUN_ID_BASENAME_PATTERN.test(base)) {
    return { safe: false, reason: `basename "${base}" does not match the ^RUN- pattern` };
  }

  const runId = base.slice('RUN-'.length);
  if (runId.includes('/') || runId.includes('..')) {
    return { safe: false, reason: `runId "${runId}" contains unsafe characters` };
  }

  return { safe: true };
}

/**
 * Remove an ephemeral clone directory (`rm -rf`, spec §8 step 4: after delivery has
 * captured any tree delta — capture-before-delete is the CALLER's responsibility,
 * this function only performs the deletion).
 *
 * Hardened per ruling 6 (D6 component 12): the old substring guard
 * (`includes('.kb-dispatch')`) is replaced with four structural checks before
 * any deletion is attempted — `realpath` the target to resolve symlinks, then
 * `checkClonePathStructure` above (canonical parent / `^RUN-` basename / safe
 * runId). A target that no longer exists is treated as already-removed
 * (`ok(undefined)`), matching `rm -rf`'s own idempotent semantics — this
 * function never had a way to report "was already gone" as distinct from
 * "removed it" and doesn't start now. Any other check failure refuses the
 * deletion with an error Result; it never throws.
 */
export async function removeClone(clonePath: string, runDir: string): Promise<DispatchResult<void>> {
  const trimmed = clonePath.trim();
  if (!trimmed) {
    return fail('Refusing to remove clone: path is empty.', { clonePath });
  }

  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Already gone. rm -rf on a missing target is a silent no-op too.
      return ok(undefined);
    }
    return fail('Refusing to remove clone: failed to resolve real path.', { clonePath, err: String(err) });
  }

  const structureCheck = checkClonePathStructure(resolved);
  if (!structureCheck.safe) {
    return fail(`Refusing to remove clone: ${structureCheck.reason}.`, { clonePath, resolved });
  }

  const scriptContent = ['#!/usr/bin/env bash', 'set -euo pipefail', `rm -rf "${resolved}"`, ''].join('\n');
  const execResult = await execViaWsl2({ runDir, scriptContent, scriptName: 'remove-clone.sh' });
  if (!execResult.ok) return execResult;

  if (execResult.data.exitCode !== 0) {
    return fail(
      `rm -rf exited with code ${execResult.data.exitCode} while removing ${resolved}.`,
      execResult.data,
    );
  }

  return ok(undefined);
}

function buildSweepScript(cloneRootShell: string, thresholdSeconds: number): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `CLONE_ROOT="${cloneRootShell}"`,
    'mkdir -p "$CLONE_ROOT"',
    'NOW=$(date +%s)',
    `THRESHOLD=${thresholdSeconds}`,
    'for d in "$CLONE_ROOT"/*/; do',
    '  [ -d "$d" ] || continue',
    '  d="${d%/}"',
    '  mtime=$(stat -c %Y "$d" 2>/dev/null || echo "$NOW")',
    '  age=$((NOW - mtime))',
    '  if [ "$age" -gt "$THRESHOLD" ]; then',
    '    rm -rf "$d"',
    '    echo "$d"',
    '  fi',
    'done',
    '',
  ].join('\n');
}

/**
 * Best-effort startup sweep of unclaimed run dirs under the clone root (spec §8
 * decision R5): removes any clone directory older than 24h. Safe by construction —
 * clones share no git metadata with the mother repo, so a stray `rm -rf` here can
 * never corrupt it. Not a hard guarantee: a slow-running legitimate clone older than
 * the threshold would also be swept; callers that need a stronger guarantee should
 * not rely on this alone.
 *
 * Unwired (ruling 6 item 4, flagged for D6/Phase 2): this function is exported and
 * unit-tested but nothing in production calls it today. Phase 2 should either wire
 * it at pipeline startup or record why it's intentionally manual — not this slice's
 * job (Phase 1b scope is the three structural checks in `removeClone` above only).
 */
export async function sweepOrphanClones(cloneRoot?: string): Promise<DispatchResult<{ removed: string[] }>> {
  const root = cloneRoot ?? DEFAULT_CLONE_ROOT;
  const scriptContent = buildSweepScript(toShellPath(root), ORPHAN_THRESHOLD_SECONDS);

  return withTempRunDir(async (runDir) => {
    const execResult = await execViaWsl2({ runDir, scriptContent, scriptName: 'sweep-clones.sh' });
    if (!execResult.ok) return execResult;

    if (execResult.data.exitCode !== 0) {
      return fail(`Sweep script exited with code ${execResult.data.exitCode}.`, execResult.data);
    }

    const removed = execResult.data.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return ok({ removed });
  });
}
