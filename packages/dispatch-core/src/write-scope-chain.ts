/**
 * WK-0163: shared ancestor-chain write_scope validator. Mirrors AgentChassis's
 * two-phase pattern (`codex-worker-write-scope-plan.mjs`'s
 * `ensureNewWorkerWriteRoots` / `assertMissingWriteRootParentContained`) —
 * walk a not-yet-existing entry UP to its nearest existing ancestor, then
 * require that ancestor's realpath stay contained within the root's realpath.
 * D2's soft symlink posture: a within-repo symlink ancestor is admitted (its
 * realpath still lands inside the root); an ancestor that resolves outside
 * the root (a symlink escape, or a `..`-relative entry with no admission-time
 * string check upstream) is refused.
 *
 * The SAME walk also resolves the entry's full target path — the nearest
 * existing ancestor's realpath, joined with the not-yet-existing remainder —
 * and refuses it when that resolved path IS the repo root, or equals,
 * contains, or lies inside the repo's `.git` (a corrected redteam finding:
 * checking only the full entry's own realpath misses a not-yet-existing
 * child of a symlinked ancestor, e.g. a tracked `alias -> .git` with entry
 * `alias/worker.txt` — the entry itself has no realpath to check until it is
 * created, but its ancestor already does). Resolving and refusing here means
 * nothing is ever created through a symlinked ancestor that aliases the root
 * or `.git` in the first place.
 *
 * Pure validation only (D1) — this never creates anything on disk;
 * admission.ts's `checkWriteScopeEntryShape` (itself called by
 * `checkStaleWriteScope` and by `createHandoff`) and pipeline.ts's
 * `precreateWriteScopeSkeleton` are the call sites, run against the mother
 * repo and the clone respectively, and all three refuse before any entry is
 * created.
 */
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

/** Mirrors admission.ts's private helper of the same name (D2's containment rule, applied identically at both call sites). */
function isWithinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export async function validateWriteScopeChain(rootDir: string, entry: string): Promise<DispatchResult<null>> {
  const rootResolved = resolve(rootDir);
  const target = resolve(rootResolved, entry);
  let ancestor = target;

  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return fail(
          'STALE_WRITE_SCOPE',
          `write_scope entry "${entry}" has no existing ancestor between it and the filesystem root.`,
          { entry },
        );
      }
      ancestor = parent;
    }
  }

  let realRoot: string;
  try {
    realRoot = await realpath(rootResolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return ok(null); // repo root does not exist on disk yet (e.g. authoring-time dry run) — nothing further to resolve.
    }
    return fail(
      'STALE_WRITE_SCOPE',
      `write_scope entry "${entry}" could not be resolved (realpath failed on the repo root).`,
      err,
    );
  }

  let realAncestor: string;
  try {
    realAncestor = await realpath(ancestor);
  } catch (err) {
    return fail(
      'STALE_WRITE_SCOPE',
      `write_scope entry "${entry}" could not be resolved (realpath failed on its nearest existing ancestor).`,
      err,
    );
  }

  if (!isWithinRoot(realRoot, realAncestor)) {
    return fail(
      'STALE_WRITE_SCOPE',
      `write_scope entry "${entry}" resolves through an ancestor outside the repo root.`,
      { entry },
    );
  }

  // The nearest existing ancestor's realpath, joined with the remainder that
  // does not exist yet (plain string join: nothing past `ancestor` exists on
  // disk, so there is no further symlink to resolve in the remainder).
  const remainder = relative(ancestor, target);
  const resolvedPath = remainder === '' ? realAncestor : join(realAncestor, remainder);

  if (resolvedPath === realRoot) {
    return fail(
      'STALE_WRITE_SCOPE',
      `write_scope entry "${entry}" resolves (through a symlink ancestor) to the repo root.`,
      { entry },
    );
  }

  let realGit: string | null;
  try {
    realGit = await realpath(join(realRoot, '.git'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return fail(
        'STALE_WRITE_SCOPE',
        `write_scope entry "${entry}" could not be resolved (realpath failed on ".git").`,
        err,
      );
    }
    realGit = null; // repo has no ".git" on disk yet — nothing to alias through.
  }
  if (realGit !== null && (resolvedPath === realGit || isWithinRoot(realGit, resolvedPath))) {
    return fail(
      'STALE_WRITE_SCOPE',
      `write_scope entry "${entry}" resolves (through a symlink ancestor) into ".git".`,
      { entry },
    );
  }

  return ok(null);
}
