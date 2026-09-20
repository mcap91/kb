/**
 * bwrap args builder (T15; spec §11 jail recipe).
 *
 * bwrap can only bind PRE-EXISTING paths — it cannot mkdir a new directory
 * under a read-only root (WK-0074 probe 1: `bwrap --ro-bind / / --bind /tmp
 * /workspace` fails with "Can't mkdir /workspace: Read-only file system" when
 * `/workspace` does not already exist). That constraint governs every path
 * this module binds — the clone, each write_scope entry, the wiki directory,
 * data mounts, the tunnel socket, the relay script — they MUST already exist
 * on disk. Pipeline.ts (W2) is responsible for pre-creating write_scope
 * skeleton dirs before calling `buildJailArgs`; this module ONLY assembles
 * the argv array. It is pure and synchronous — no I/O, no process spawning —
 * and cannot fail, so it never returns a `DispatchResult`.
 *
 * ## S5 full recipe (spec §11), applied in argument order — bwrap resolves
 * later binds over earlier ones:
 *
 *   1.  --ro-bind-try <root> <root>   curated system roots only (DEC-0011,
 *                                      WK-0103 visibility wall — replaces the
 *                                      former whole-root `--ro-bind / /`; see
 *                                      SYSTEM_ROOTS)
 *   2.  --proc /proc                  live procfs (child spawning)
 *   3.  --dev /dev                    device nodes (WK-0086: `nodev` on the
 *                                      ro-bind root broke nested bash spawn)
 *   4.  --tmpfs /tmp                  writable scratch space — Pi and other
 *                                      in-jail tooling need a writable /tmp;
 *                                      unconditional whenever the full S5
 *                                      recipe runs
 *   5.  --die-with-parent             cleanup on parent exit
 *   6.  --unshare-net                 opt-in (T26/D21): no network stack
 *   6a. toolchain leaf binds (DEC-0011) --ro-bind-try each opts.toolchainPaths
 *                                      entry (CLI binaries living under $HOME)
 *   6b. auth leaf binds (DEC-0011)    the ONLY $HOME paths let through —
 *                                      opts.authLeafBinds, ro or rw per entry
 *   7.  clone bind                    ro-bind first if write_scope is
 *                                      sparse, else writable (legacy shape)
 *   8.  write_scope binds             selective rw layered over step 7
 *   9.  wiki read axis (T25/D19)      dual-shape probe result decides mask
 *                                      vs. explicit bind vs. no-op
 *   10. data mounts                   per-HO ro/rw binds (existence/
 *                                      absoluteness already §7.14-validated
 *                                      by the admission gate)
 *   11. tunnel socket bind (T26/D21)  egress-forwarder unix socket
 *   12. relay script bind (T26/D21)   in-jail relay, read-only
 *   13. --chdir <cwd>
 *   14. --                            terminates bwrap's own argv; the
 *                                      caller appends the worker invocation
 */
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Wiki shape in the mother repo — the dual-shape read axis (T25, D19). */
export type WikiShape = 'tracked' | 'nested-private';

export interface JailOpts {
  /** Absolute path to the ext4 clone directory (inside WSL2). */
  clonePath: string;
  /** Working directory inside the jail (usually = clonePath). */
  cwd?: string;

  // --- S5 additions ---

  /** Relative paths under clonePath that the worker may write to (from HO write_scope).
   *  Each path gets a writable bind; everything else under clonePath stays read-only. */
  writeScope?: string[];
  /** Wiki shape — determines whether to mask or bind wiki. */
  wikiShape?: WikiShape;
  /** HO mode — determines wiki visibility (implement/code_review: masked; redteam/research: visible). */
  mode?: string;
  /** Absolute path to the mother repo's wiki/ (for nested-private shape, redteam/research bind). */
  motherWikiPath?: string;
  /** Data mount declarations from the HO (format: "ro:/path/to/data" or "rw:/path/to/data"). */
  dataMounts?: string[];
  /** Whether to unshare the network namespace (true for S5 enforcement). */
  unshareNet?: boolean;
  /** Path to the tunnel unix socket to bind-mount into the jail. */
  tunnelSocketPath?: string;
  /** Path inside the jail where the relay script lives (for bind-mounting). */
  relayScriptPath?: string;

  // --- DEC-0011 / WK-0103 additions: curated visibility wall ---

  /** Curated system-root dirs to bind read-only-try (replaces the whole-root bind).
   *  Default: SYSTEM_ROOTS constant. The caller may extend but never narrow. */
  systemRoots?: readonly string[];

  /** Toolchain paths under $HOME that the worker's CLI binary needs (resolved at
   *  dispatch time via `which`). Each gets an --ro-bind-try. */
  toolchainPaths?: readonly string[];

  /** Per-family auth leaf file binds — the ONLY $HOME paths let through.
   *  Each entry is { path, access } where access = 'ro' | 'rw'. */
  authLeafBinds?: ReadonlyArray<{ path: string; access: 'ro' | 'rw' }>;

  /** Absolute path to the run directory (prompt, relay script, tunnel socket,
   *  logs). Bound writable — chassis's `runtimeRoots` category. */
  runDirPath?: string;
}

export interface JailArgs {
  /** The bwrap argument array. Caller appends the worker invocation argv after this. */
  argv: string[];
}

/**
 * Probe whether wiki/ is git-tracked in the mother repo (T25, D19).
 *
 * - 'tracked': the clone carries the wiki (the intended consuming-repo
 *   shape) — non-empty `git ls-files wiki/` output.
 * - 'nested-private': wiki/ is gitignored or lives in a separate repo (kb's
 *   own dev-rig shape) — empty `git ls-files wiki/` output.
 *
 * Pure and synchronous: this takes the ALREADY-CAPTURED stdout of
 * `git ls-files wiki/` — it never runs git itself. The caller (pipeline.ts,
 * W2) runs the command and passes its output through here. Never assume
 * either shape (DEC-0008 D19): kb's own repo is nested-private, but the
 * intended consuming-repo product shape is tracked — both must be handled.
 */
export function classifyWikiShape(lsFilesOutput: string): WikiShape {
  return lsFilesOutput.trim().length > 0 ? 'tracked' : 'nested-private';
}

export interface ParsedDataMount {
  access: 'ro' | 'rw';
  hostPath: string;
}

/**
 * Parse a data_mounts entry like "ro:/data/reference" or "rw:/tmp/scratch".
 * Returns null for anything that doesn't match the `(ro|rw):<path>` shape.
 * Malformed entries are skipped by `buildJailArgs` rather than thrown — the
 * admission gate's `bad_data_mount` check (§7.14) is the validating gate;
 * this parser stays defensive-but-silent to hold jail.ts's "cannot fail"
 * contract.
 */
export function parseDataMount(entry: string): ParsedDataMount | null {
  const match = /^(ro|rw):(.+)$/.exec(entry);
  if (!match) return null;
  return { access: match[1] as 'ro' | 'rw', hostPath: match[2] };
}

/** Modes whose workers must never see wiki content — masked when wiki/ is tracked. */
const WIKI_MASKED_MODES: ReadonlySet<string> = new Set(['implement', 'code_review']);
/** Modes allowed to read wiki content — get an explicit bind when wiki/ is nested-private. */
const WIKI_VISIBLE_MODES: ReadonlySet<string> = new Set(['redteam', 'research']);

/**
 * Curated system-root dirs bound read-only into every jail (chassis pattern:
 * buildSystemBaselineArgs's systemReadOnlyRoots loop,
 * launch-isolation-bwrap.mjs:59-95). --ro-bind-try so absent dirs (e.g.
 * /lib64 on non-x86) are silently skipped rather than failing bwrap.
 */
export const SYSTEM_ROOTS: readonly string[] = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/var',
];

/**
 * Join a write_scope-style relative path onto the clone root. Strips leading
 * and trailing slashes from the relative segment so both "src/" and "src"
 * (the write_scope directory-prefix convention — see delivery.ts's
 * `checkWriteScope`) resolve to the same bind target.
 */
function joinUnderClone(clonePath: string, relPath: string): string {
  const trimmed = relPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? `${clonePath}/${trimmed}` : clonePath;
}

/**
 * D6 (PLN-0004 `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md`
 * ruling 7, components 1-4): one internal step-builder that both
 * `buildJailArgs` (existing script-argv contract, pinned byte-for-byte by
 * `tests/dispatch-v2-jail.test.ts`) and `buildBwrapPlan` (new frozen-plan
 * contract, below) render from. The mount LOGIC here — write_scope sparse
 * binds, the T25/D19 wiki axis, data mounts, tunnel/relay binds — is
 * UNCHANGED from the walk `buildJailArgs` always did (same conditions, same
 * order, same values); it is only restructured to record each step twice
 * (a flat argv token pair AND a structured `{kind,src,dst}` record) instead
 * of once. Not exported — an implementation seam, not a public contract.
 */
interface JailPlanSteps {
  /** Steps 1-12 (system baseline through relay-script bind) as flat argv tokens — EXCLUDES the leading 'bwrap' program name and the trailing steps 13-14 (`--chdir <cwd>` + `--`), which each caller appends per its own contract. */
  mountArgv: string[];
  /** The same steps 1-12, structured — mirrors agent-chassis's plan-mounts `{src,dst}` shape (`launch-isolation-plan-mounts.mjs:185-499`). */
  mounts: BwrapMount[];
  /** Resolved --chdir target (`opts.cwd ?? opts.clonePath`). */
  cwd: string;
}

function buildJailPlanSteps(opts: JailOpts): JailPlanSteps {
  const cwd = opts.cwd ?? opts.clonePath;
  const mountArgv: string[] = [];
  const mounts: BwrapMount[] = [];

  const bind = (kind: 'ro-bind' | 'ro-bind-try' | 'bind', src: string, dst: string): void => {
    const flag = kind === 'ro-bind' ? '--ro-bind' : kind === 'ro-bind-try' ? '--ro-bind-try' : '--bind';
    mountArgv.push(flag, src, dst);
    mounts.push({ kind, src, dst });
  };
  const synthetic = (kind: 'tmpfs' | 'proc' | 'dev', dst: string): void => {
    mountArgv.push(kind === 'tmpfs' ? '--tmpfs' : kind === 'proc' ? '--proc' : '--dev', dst);
    mounts.push({ kind, dst });
  };

  // 1. Curated system-root ro-bind-try (DEC-0011: deny-by-default visibility;
  //    replaces the whole-root ro-bind that gave every jail blanket $HOME
  //    access). --ro-bind-try so a root absent on this host (e.g. /lib64 on
  //    a non-multilib arch) is silently skipped rather than failing bwrap.
  const roots = opts.systemRoots ?? SYSTEM_ROOTS;
  for (const root of roots) {
    bind('ro-bind-try', root, root);
  }
  // 2-3: live procfs + device nodes (unchanged since S0).
  synthetic('proc', '/proc');
  synthetic('dev', '/dev');
  // 4: writable scratch space — new at S5, unconditional whenever the full
  // recipe runs (Pi and other in-jail tooling need a writable /tmp).
  synthetic('tmpfs', '/tmp');
  // 5: cleanup on parent exit (unchanged since S0).
  mountArgv.push('--die-with-parent');
  // 6: network namespace removal (T26/D21) — opt-in.
  if (opts.unshareNet) {
    mountArgv.push('--unshare-net');
  }

  // 6-rundir: run directory as a writable bind (chassis: runtimeRoots).
  // Prompt, relay script, tunnel socket, and logs all live here.
  if (opts.runDirPath) {
    bind('bind', opts.runDirPath, opts.runDirPath);
  }

  // 6a. Toolchain binary paths under $HOME — exact leaves, never a $HOME directory bind.
  if (opts.toolchainPaths) {
    for (const p of opts.toolchainPaths) {
      bind('ro-bind-try', p, p);
    }
  }

  // 6b. Per-family auth leaf binds — the ONLY $HOME paths (DEC-0011 wall 1).
  if (opts.authLeafBinds) {
    for (const leaf of opts.authLeafBinds) {
      bind(leaf.access === 'rw' ? 'bind' : 'ro-bind', leaf.path, leaf.path);
    }
  }

  // 7-8: clone bind(s). Sparse write_scope mode (writeScope provided, even
  // empty): ro-bind the clone, then layer writable binds over each declared
  // path. Legacy mode (writeScope not provided): bind the whole clone
  // writable, matching S0.
  if (opts.writeScope !== undefined) {
    bind('ro-bind', opts.clonePath, opts.clonePath);
    for (const rel of opts.writeScope) {
      const target = joinUnderClone(opts.clonePath, rel);
      bind('bind', target, target);
    }
  } else {
    bind('bind', opts.clonePath, opts.clonePath);
  }

  // 9: dual-shape wiki read axis (T25/D19).
  const wikiPath = joinUnderClone(opts.clonePath, 'wiki');
  if (opts.wikiShape === 'tracked') {
    if (opts.mode !== undefined && WIKI_MASKED_MODES.has(opts.mode)) {
      synthetic('tmpfs', wikiPath);
    }
    // redteam/research (or an unrecognized mode): leave the clone's own wiki/ visible.
  } else if (opts.wikiShape === 'nested-private') {
    if (opts.mode !== undefined && WIKI_VISIBLE_MODES.has(opts.mode) && opts.motherWikiPath) {
      bind('ro-bind', opts.motherWikiPath, wikiPath);
    }
    // implement/code_review (or no motherWikiPath given): clone has no wiki/ at all — nothing to bind.
  }

  // 10: declared data mounts (ro/rw per HO; existence/absoluteness already
  // validated by the admission gate's bad_data_mount check, §7.14).
  if (opts.dataMounts) {
    for (const entry of opts.dataMounts) {
      const parsed = parseDataMount(entry);
      if (parsed === null) continue;
      bind(parsed.access === 'ro' ? 'ro-bind' : 'bind', parsed.hostPath, parsed.hostPath);
    }
  }

  // 11: tunnel socket bind (T26/D21 egress enforcement).
  if (opts.tunnelSocketPath) {
    bind('bind', opts.tunnelSocketPath, opts.tunnelSocketPath);
  }

  // 12: in-jail relay script bind (T26/D21), read-only.
  if (opts.relayScriptPath) {
    bind('ro-bind', opts.relayScriptPath, opts.relayScriptPath);
  }

  return { mountArgv, mounts, cwd };
}

/**
 * Build the bwrap argv for jailing a worker to its ephemeral clone.
 * Pure and synchronous — this only assembles an argument array, it never
 * spawns anything and cannot fail, so it does not return a `DispatchResult`.
 *
 * Always builds the full §11 recipe in the 14-step order documented above.
 */
export function buildJailArgs(opts: JailOpts): JailArgs {
  const { mountArgv, cwd } = buildJailPlanSteps(opts);
  // 13-14: cwd + terminator (the caller appends the worker invocation after this).
  return { argv: ['bwrap', ...mountArgv, '--chdir', cwd, '--'] };
}

// ---------------------------------------------------------------------------
// D6 (PLN-0004 mid_project_review_rulings.md ruling 7, components 1-4):
// frozen bwrap plan object. Replaces the generated-bash-script +
// execViaWsl2 pattern with a plan `spawn-isolated.ts` hands directly to
// `spawn('bwrap', plan.bwrapArgs, ...)`. Mirrors agent-chassis's
// buildBubblewrapLaunchPlan (`launch-isolation-plan.mjs:29-284`, frozen
// return shape at :233-284) and buildBubblewrapArgs
// (`launch-isolation-bwrap-args.mjs:8-126`). ELv2 — design mirrored only;
// this TypeScript is written from scratch, no chassis source copied.
//
// buildJailArgs above is UNCHANGED (pipeline.ts's script-generation path
// still calls it; Phase 2 removes that call site and this whole section
// grows into its replacement). Both functions now render from the single
// `buildJailPlanSteps` walk above — the mount LOGIC is identical, only the
// output shape differs.
// ---------------------------------------------------------------------------

/**
 * One structured bind/mount operation, in application order — mirrors
 * chassis's plan-mounts `{src,dst}` shape (`launch-isolation-plan-mounts.mjs
 * :185-499`). `src` is absent for the synthetic proc/dev/tmpfs mounts (no
 * host source path). For diagnostics/provenance only — `buildBwrapPlan`
 * already renders the equivalent flag pairs into `bwrapArgs`.
 */
export interface BwrapMount {
  kind: 'ro-bind' | 'ro-bind-try' | 'bind' | 'tmpfs' | 'proc' | 'dev';
  src?: string;
  dst: string;
}

/**
 * A file bwrap materializes inside the jail via `--file FD DEST` (D6 V3
 * component 15 — in-jail config materialization, e.g. models.json under the
 * worker's /tmp tmpfs config dir; replaces the heredoc pipeline.ts used to
 * write inside the generated script, since `/tmp` is jail tmpfs and doesn't
 * exist until bwrap itself mounts it — WK-0088 invariant, this module's own
 * doc above).
 *
 * Captured directly against bubblewrap 0.9.0 on this host (2026-09-16,
 * DEC-0009 capture-before-code — `[UNVERIFIED-SHAPE]` in the ruling until
 * this run): unlike `--bind`/`--ro-bind` (which require the destination to
 * already exist), `--file` auto-creates missing parent directories, and
 * accepts a pipe-backed fd (not just a regular seekable file) —
 * `--file 3 /tmp/.pi-agent/models.json` materialized correctly against fd 3
 * fed by a fifo (bash process substitution), and two `--file` entries can
 * share a newly-created parent directory. Default mode is 0666
 * (umask-subject; bwrap's `--perms` would tighten this, not wired here —
 * nothing currently injected is secret-shaped, see pipeline.ts's
 * script-side `injectionScript` for how actual credentials are handled).
 */
export interface BwrapInjectedFile {
  /** fd bwrap reads from — 3, 4, 5, ... in declaration order (0-2 are reserved for the child's own stdio). Assigned by `buildBwrapPlan`; `spawnIsolated` wires a pipe at this same stdio index. */
  fd: number;
  /** Destination path inside the jail. */
  dest: string;
  /** File content to materialize at dest. */
  content: string;
}

/**
 * Frozen plan object — mirrors agent-chassis's buildBubblewrapLaunchPlan
 * return shape (`launch-isolation-plan.mjs:233-284`): the full bwrap argv,
 * structured mount provenance, and the resolved env/cwd/command, ready for a
 * direct `spawn('bwrap', plan.bwrapArgs, ...)` (`spawn-isolated.ts`,
 * mirroring `launch-isolation-spawn.mjs:250-255`).
 */
export interface BwrapPlan {
  /**
   * Full bwrap argv, EXCLUDING the 'bwrap' program name itself — Node's
   * `spawn(command, args)` takes the binary and args separately, unlike the
   * shell-command form `buildJailArgs`'s argv was designed for (which needs
   * 'bwrap' as argv[0] of the composed command line, see `buildJailArgs`
   * above). Includes the trailing `--chdir <cwd> -- <command...>`; ready to
   * hand directly to `spawn('bwrap', plan.bwrapArgs, ...)` with no further
   * mutation.
   */
  bwrapArgs: readonly string[];
  /** Structured mount records in application order — the same binds `bwrapArgs` encodes, for diagnostics/provenance. */
  mounts: readonly BwrapMount[];
  /** Files bwrap materializes inside the jail via `--file` (already reflected in `bwrapArgs`); `spawnIsolated` reads this to wire the matching pipes. */
  injectedFiles: readonly BwrapInjectedFile[];
  /** Environment for the spawned bwrap process itself (`child_process.spawn`'s `env`) — NOT in-jail `--setenv` (D6 component 9, env-policy allow/deny-listing, is separate future work; this plan's mount recipe is unchanged from `buildJailArgs` and still relies on bwrap's default env passthrough into the sandboxed child). */
  env: Record<string, string>;
  /** Working directory inside the jail (mirrors the `--chdir` argument already baked into `bwrapArgs`). */
  cwd: string;
  /** Worker command + argv — already embedded at the end of `bwrapArgs` after `--`; surfaced separately for logging/provenance (mirrors chassis's `childCommand`/`childArgs`, `launch-isolation-plan.mjs:237-239`). */
  command: readonly string[];
}

export interface BuildBwrapPlanOpts extends JailOpts {
  /** Worker command + argv to run inside the jail (appended after bwrap's own `--` terminator), e.g. `['pi', '-p', '--mode', 'json', ...]`. */
  command: string[];
  /** Environment for the spawned bwrap process (`child_process.spawn`'s `env`). Defaults to `{}`. */
  env?: Record<string, string>;
  /** Files to materialize inside the jail via bwrap `--file` (e.g. models.json under the worker's tmpfs config dir). fd numbers are assigned here, in array order, starting at 3. */
  injectedFiles?: ReadonlyArray<{ content: string; dest: string }>;
}

/**
 * Build the frozen bwrap plan for jailing a worker to its ephemeral clone
 * (D6). Pure and synchronous — same "cannot fail" contract as
 * `buildJailArgs`: this only assembles data, it never touches the
 * filesystem or spawns anything.
 */
export function buildBwrapPlan(opts: BuildBwrapPlanOpts): BwrapPlan {
  const { mountArgv, mounts, cwd } = buildJailPlanSteps(opts);

  const injectedFiles: BwrapInjectedFile[] = (opts.injectedFiles ?? []).map((f, i) => ({
    fd: 3 + i,
    dest: f.dest,
    content: f.content,
  }));
  // --file is a bwrap OPTION (parsed like --bind etc.), so it must land
  // before the `--` terminator — after it, tokens belong to the worker's own
  // argv instead of bwrap.
  const fileArgv = injectedFiles.flatMap((f) => ['--file', String(f.fd), f.dest]);

  return {
    bwrapArgs: [...mountArgv, ...fileArgv, '--chdir', cwd, '--', ...opts.command],
    mounts,
    injectedFiles,
    env: { ...(opts.env ?? {}) },
    cwd,
    command: [...opts.command],
  };
}

// ---------------------------------------------------------------------------
// Per-family bwrap plan differentiation (D2 ruling 2, PLN-0004
// `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md:149-201`;
// design source agent-chassis `docs/enforcement-model.md:505-550` — ELv2,
// design mirrored only, no chassis source copied). Pi's existing sparse-bind
// recipe above (buildJailPlanSteps's write_scope loop, unmodified) stays the
// default for any family that isn't claude/codex. These are standalone
// classification helpers — pipeline.ts (step 12d) uses their output to build
// a family-specific `writeScope` override before calling the UNMODIFIED
// `buildBwrapPlan` above; they are not new recipe steps inside
// `buildJailPlanSteps` itself.
//
// Both functions need to know whether a write_scope entry names a FILE or a
// DIRECTORY, which — unlike the rest of this file — requires real filesystem
// I/O (`stat`). `classifyEntry` below is the shared classifier: `statSync`
// when the path already exists in the clone, falling back to an extension
// heuristic when it doesn't (a write_scope entry may legitimately name a
// file the worker hasn't created yet).
// ---------------------------------------------------------------------------

type EntryKind = 'file' | 'directory';

/**
 * Heuristic used only when a write_scope path does not yet exist on disk: a
 * dot followed by one or more alphanumeric characters at the end of the
 * final path segment reads as a file extension (`.ts`, `.js`, `.mjs`,
 * `.json`, `.md`, `.yaml`, `.yml`, and any other conventional extension);
 * anything else (no dot, or a trailing-slash directory entry, whose final
 * split segment is empty) reads as a directory.
 */
function looksLikeFile(relPath: string): boolean {
  const basename = relPath.split('/').pop() ?? relPath;
  return /\.[A-Za-z0-9]+$/.test(basename);
}

/**
 * Classify one write_scope entry (already resolved onto the clone root) as a
 * file or a directory: `stat()` when the path exists on disk; the extension
 * heuristic above when it doesn't (ENOENT) — or, defensively, on any other
 * stat error, since this module's "cannot fail" contract (top-of-file doc)
 * means a permission error must degrade to the heuristic rather than throw.
 */
function classifyEntry(absPath: string, relPath: string): EntryKind {
  try {
    return statSync(absPath).isDirectory() ? 'directory' : 'file';
  } catch {
    return looksLikeFile(relPath) ? 'file' : 'directory';
  }
}

/**
 * Claude: widen file-scope write_scope entries to their PARENT DIRECTORY.
 * Claude Code writes via atomic rename (temp sibling + `rename(2)`), which
 * needs write+execute on the CONTAINING directory, not just the target file
 * — binding only the exact file (as Codex's `deriveExactFileMounts` below
 * does) would make every Claude edit fail at the rename step. Directory
 * entries stay as-is. Returns de-duplicated ABSOLUTE directory paths under
 * `clonePath` — pipeline.ts converts these back to clone-relative paths
 * before handing them to `buildBwrapPlan`'s own `writeScope` param (which
 * re-resolves relative entries itself via this module's `joinUnderClone`).
 */
export function deriveDirectoryScopedMounts(writeScope: string[], clonePath: string): string[] {
  const dirs = new Set<string>();
  for (const rel of writeScope) {
    const absPath = joinUnderClone(clonePath, rel);
    const kind = classifyEntry(absPath, rel);
    dirs.add(kind === 'file' ? dirname(absPath) : absPath);
  }
  return Array.from(dirs);
}

/**
 * Codex: classify write_scope entries as exact files or directories — Codex
 * gets exact-file kernel binds (`--bind <file> <file>`, parent directory
 * stays read-only) rather than Claude's directory-widened mounts above.
 * Returns ABSOLUTE paths in each bucket, same convention as
 * `deriveDirectoryScopedMounts`.
 */
export function deriveExactFileMounts(
  writeScope: string[],
  clonePath: string,
): { writableDirs: string[]; writableFiles: string[] } {
  const writableDirs: string[] = [];
  const writableFiles: string[] = [];
  for (const rel of writeScope) {
    const absPath = joinUnderClone(clonePath, rel);
    if (classifyEntry(absPath, rel) === 'file') {
      writableFiles.push(absPath);
    } else {
      writableDirs.push(absPath);
    }
  }
  return { writableDirs, writableFiles };
}

/**
 * `.env` / `.claude/` secret-masking bwrap args (D2 ruling 2 item 5, mirrors
 * agent-chassis): mask `<clone>/.env` with `/dev/null` (a worker must never
 * be able to read secrets baked into the mother repo's own working-tree
 * `.env`) and mask `<clone>/.claude/` with a fresh tmpfs (a committed
 * `.claude/` config must never reach the jail). `buildBwrapPlan` requires
 * bind TARGETS to already exist (this module's own top-of-file doc) — this
 * checks existence itself so it never emits an arg bwrap would reject; empty
 * array when neither path exists in the clone.
 */
export function buildSecretMaskArgs(clonePath: string): string[] {
  const args: string[] = [];
  const envPath = `${clonePath}/.env`;
  const claudeDirPath = `${clonePath}/.claude`;
  if (existsSync(envPath)) {
    args.push('--ro-bind', '/dev/null', envPath);
  }
  if (existsSync(claudeDirPath)) {
    args.push('--tmpfs', claudeDirPath);
  }
  return args;
}
