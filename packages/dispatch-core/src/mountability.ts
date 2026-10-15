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
 */

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
