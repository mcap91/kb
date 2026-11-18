/**
 * Mountability primitives shared by jail.ts, pipeline.ts, and admission.ts
 * (WK-0201 fix-up F2, HO-0090). `SYSTEM_ROOTS` and `isMountableRoot` used to
 * live in jail.ts / pipeline.ts respectively, but admission.ts needs
 * `isMountableRoot` for its `runtime_envs` gate (`checkRuntimeEnvs`) while
 * pipeline.ts needs `checkAdmission` from admission.ts — importing
 * `isMountableRoot` from pipeline.ts made that a cycle. This module has no
 * imports from jail.ts, pipeline.ts, or admission.ts, so it can be imported
 * by all three without creating one. jail.ts and pipeline.ts re-export
 * `SYSTEM_ROOTS` / `isMountableRoot` respectively so existing external
 * imports (tests included) keep working unchanged.
 *
 * `isWithinRoot` and `checkDataMountEntry` are the shared data-mount
 * entry rule: admission.ts's handoff `data_mounts`/`export_mounts` check and
 * host-validation.ts's registry `data_mounts` check both call
 * `checkDataMountEntry` so the two surfaces apply one definition, not two
 * copies that could drift.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

/**
 * Curated system-root dirs bound read-only into every jail (chassis pattern:
 * buildSystemBaselineArgs's systemReadOnlyRoots loop,
 * launch-isolation-bwrap.mjs:59-95). --ro-bind-try so absent dirs (e.g.
 * /lib64 on non-x86) are silently skipped rather than failing bwrap.
 */
export const SYSTEM_ROOTS: readonly string[] = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/var',
];

/** True when `path` is under $HOME or one of jail.ts's curated SYSTEM_ROOTS. */
export function isMountableRoot(path: string, home: string): boolean {
  if (home.length > 0 && (path === home || path.startsWith(`${home}/`))) return true;
  return SYSTEM_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** True when `target` (pre-resolved absolute) is `root` itself or one of its descendants. */
export function isWithinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Why a path failed the data-mount entry rule below. */
export type DataMountEntryViolation = 'not_absolute' | 'not_found' | 'inside_root';

export type DataMountEntryCheck = { ok: true; resolved: string } | { ok: false; violation: DataMountEntryViolation };

/**
 * The data-mount entry rule: an entry must be an absolute path,
 * must exist on disk, and must resolve outside the repo root. `resolve(entry)`
 * normalizes without following symlinks — a symlinked entry's declared path
 * is what is judged (and, for the validation registry, later bound), not its
 * realpath target. Each caller renders its own error code and message from
 * the returned violation kind.
 */
export async function checkDataMountEntry(entry: string, repoRootResolved: string): Promise<DataMountEntryCheck> {
  if (!isAbsolute(entry)) return { ok: false, violation: 'not_absolute' };
  const resolved = resolve(entry);
  try {
    await stat(resolved);
  } catch {
    return { ok: false, violation: 'not_found' };
  }
  if (isWithinRoot(repoRootResolved, resolved)) return { ok: false, violation: 'inside_root' };
  return { ok: true, resolved };
}
