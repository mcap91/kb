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
 *   1.  --ro-bind / /                 entire host read-only
 *   2.  --proc /proc                  live procfs (child spawning)
 *   3.  --dev /dev                    device nodes (WK-0086: `nodev` on the
 *                                      ro-bind root broke nested bash spawn)
 *   4.  --tmpfs /tmp                  writable scratch space — Pi and other
 *                                      in-jail tooling need a writable /tmp;
 *                                      unconditional whenever the full S5
 *                                      recipe runs
 *   5.  --die-with-parent             cleanup on parent exit
 *   6.  --unshare-net                 opt-in (T26/D21): no network stack
 *   7.  clone bind                    ro-bind first if write_scope is
 *                                      sparse, else writable (legacy shape)
 *   8.  write_scope binds             selective rw layered over step 7
 *   9.  .dispatch-out/ bind (S6a W4)  dispatch-owned worker-output dir —
 *                                      always writable, unconditional across
 *                                      every mode (not gated by write_scope);
 *                                      carries review.yaml (code_review's
 *                                      file-artifact deliverable)
 *   10. wiki read axis (T25/D19)      dual-shape probe result decides mask
 *                                      vs. explicit bind vs. no-op
 *   11. data mounts                   per-HO ro/rw binds (existence/
 *                                      absoluteness already §7.14-validated
 *                                      by the admission gate)
 *   12. tunnel socket bind (T26/D21)  egress-forwarder unix socket
 *   13. relay script bind (T26/D21)   in-jail relay, read-only
 *   14. --chdir <cwd>
 *   15. --                            terminates bwrap's own argv; the
 *                                      caller appends the worker invocation
 */

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
  /** Steps 1-13 (system baseline through relay-script bind) as flat argv tokens — EXCLUDES the leading 'bwrap' program name and the trailing steps 14-15 (`--chdir <cwd>` + `--`), which each caller appends per its own contract. */
  mountArgv: string[];
  /** The same steps 1-13, structured — mirrors agent-chassis's plan-mounts `{src,dst}` shape (`launch-isolation-plan-mounts.mjs:185-499`). */
  mounts: BwrapMount[];
  /** Resolved --chdir target (`opts.cwd ?? opts.clonePath`). */
  cwd: string;
}

function buildJailPlanSteps(opts: JailOpts): JailPlanSteps {
  const cwd = opts.cwd ?? opts.clonePath;
  const mountArgv: string[] = [];
  const mounts: BwrapMount[] = [];

  const bind = (kind: 'ro-bind' | 'bind', src: string, dst: string): void => {
    mountArgv.push(kind === 'ro-bind' ? '--ro-bind' : '--bind', src, dst);
    mounts.push({ kind, src, dst });
  };
  const synthetic = (kind: 'tmpfs' | 'proc' | 'dev', dst: string): void => {
    mountArgv.push(kind === 'tmpfs' ? '--tmpfs' : kind === 'proc' ? '--proc' : '--dev', dst);
    mounts.push({ kind, dst });
  };

  // 1-3: host read-only root + live procfs + device nodes (unchanged since S0).
  bind('ro-bind', '/', '/');
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

  // 9: .dispatch-out/ (S6a W4) — dispatch-owned worker-output dir (review.yaml
  // is code_review's file-artifact deliverable; DEC-0010 retired outcome.yaml).
  // Unconditional and layered AFTER the
  // write_scope binds above regardless of mode, so it is writable even when
  // write_scope is empty (code_review's envelope grants no write authority at
  // all — see assemble.ts's code_review framing). Self-bind, same pattern as
  // the write_scope binds: pipeline.ts must `mkdir -p` this path in the clone
  // before calling buildJailArgs (bwrap cannot mkdir a new path under a
  // ro-bound root — see this module's own doc above).
  const dispatchOutPath = joinUnderClone(opts.clonePath, '.dispatch-out');
  bind('bind', dispatchOutPath, dispatchOutPath);

  // 10: dual-shape wiki read axis (T25/D19).
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

  // 11: declared data mounts (ro/rw per HO; existence/absoluteness already
  // validated by the admission gate's bad_data_mount check, §7.14).
  if (opts.dataMounts) {
    for (const entry of opts.dataMounts) {
      const parsed = parseDataMount(entry);
      if (parsed === null) continue;
      bind(parsed.access === 'ro' ? 'ro-bind' : 'bind', parsed.hostPath, parsed.hostPath);
    }
  }

  // 12: tunnel socket bind (T26/D21 egress enforcement).
  if (opts.tunnelSocketPath) {
    bind('bind', opts.tunnelSocketPath, opts.tunnelSocketPath);
  }

  // 13: in-jail relay script bind (T26/D21), read-only.
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
  // 14-15: cwd + terminator (the caller appends the worker invocation after this).
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
  kind: 'ro-bind' | 'bind' | 'tmpfs' | 'proc' | 'dev';
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
