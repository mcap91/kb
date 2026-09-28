/**
 * WK-0163: shared ancestor-chain write_scope validator. Mirrors AgentChassis's
 * two-phase pattern (`codex-worker-write-scope-plan.mjs`'s
 * `ensureNewWorkerWriteRoots` / `assertMissingWriteRootParentContained`) —
 * walk a not-yet-existing entry UP to its nearest existing ancestor, then
 * require that ancestor's realpath stay contained within the root's realpath.
 * D2's soft symlink posture: a within-repo symlink ancestor is admitted (its
 * realpath still lands inside the root); an ancestor that resolves outside
 * the root (a symlink escape, or a `..`-relative entry with no admission-time
 * string check upstream) is refused. Pure validation only (D1) — this never
 * creates anything on disk; admission.ts's `checkStaleWriteScope` and
 * pipeline.ts's `precreateWriteScopeSkeleton` are the two call sites, run
 * against the mother repo and the clone respectively.
 */
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
  let ancestor = resolve(rootResolved, entry);

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

  let realAncestor: string;
  let realRoot: string;
  try {
    realAncestor = await realpath(ancestor);
    realRoot = await realpath(rootResolved);
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

  return ok(null);
}
