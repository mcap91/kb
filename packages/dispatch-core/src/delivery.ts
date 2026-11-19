/**
 * §8 delivery gate (dispatch v2, PLN-0004 S0, T6). Ports the WK-0074 B4R
 * correctness script (`scratch_space/WSL2_spikes/b4r_correctness.sh`, proven
 * 21/21) — the stage -> check -> land protocol is carried into
 * script-generating + result-parsing TypeScript functions here, not
 * re-derived.
 *
 * This module produces bash script CONTENT and parses script OUTPUT; it does
 * not execute anything itself. Wave 2a builds `wsl2.ts` (the WSL2 exec
 * helper) in parallel disjoint files, so this module cannot depend on it.
 * Wave 3's `pipeline.ts` wires the two together: generate a script here,
 * execute it via wsl2.ts, parse the result back here.
 *
 * Frozen git config on every launcher-side git call (spec §8, b4r script):
 * `-c core.autocrlf=false -c core.eol=lf -c core.hooksPath= -c core.fsmonitor=`.
 * Pinned committer: `kb-dispatch <dispatch@kb.local>` (GIT_COMMITTER_NAME/EMAIL
 * and GIT_AUTHOR_NAME/EMAIL env vars). Delivery always stages into a temp index
 * (GIT_INDEX_FILE) — never the real index — and lands via plumbing
 * (read-tree/write-tree/commit-tree) + a CAS `push` onto
 * `refs/heads/dispatch/<handoffId>`: same tree from the same base as the
 * existing tip is an idempotent no-op; a different tree from the same base
 * is a structured conflict, never a clobber (b4r script tests 3-5).
 *
 * None of the functions in this module throw. `checkWriteScope`/`scanSecrets`,
 * `parseStageOutput`, `runStageScript` and `parseLandOutput` return a minimal
 * local `{ ok }` shape (not the shared `DispatchResult`). The few file reads
 * (`parseStageOutput`) and the temp-dir lifecycle (`runStageScript`) fail
 * closed into that same local shape rather than throwing.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execBash, MAX_BUFFER_BYTES } from './exec-direct.js';
import { ENV_NAME } from './repo-config.js';

/** Frozen git config flags carried on every launcher-side git invocation (spec §8). */
const FROZEN_GIT_CONFIG = '-c core.autocrlf=false -c core.eol=lf -c core.hooksPath= -c core.fsmonitor=';

/**
 * Options for the eventual full delivery run. This is the wave-3
 * `pipeline.ts` shape (clone + mother repo + handoff identity); nothing in
 * this file executes against it — see the module doc above.
 */
export interface DeliveryOpts {
  /** WSL2 path to the ephemeral clone */
  clonePath: string;
  /** WSL2 path to the mother repo (via /mnt/c/...) */
  motherRepoWsl: string;
  /** The handoff record (for write_scope, id) */
  handoffId: string;
  writeScope: string[];
  /** base_sha the clone was created from */
  baseSha: string;
  /** Absolute Windows path to the run dir (for script staging + quarantine) */
  runDir: string;
}

export type DeliveryOutcome =
  | { status: 'delivered'; branch: string; commitSha: string; changedFiles: string[]; ignoredFiles?: string[] }
  | { status: 'no_changes' }
  | { status: 'no_delta'; ignoredFiles?: string[] }
  | { status: 'refused_out_of_scope'; offendingPaths: string[]; quarantinePath: string }
  | { status: 'secret_in_diff'; patterns: string[]; quarantinePath: string }
  | { status: 'conflict'; existingTree: string; newTree: string }
  | { status: 'error'; message: string };

/** A generated bash script: its content plus a stable name for capture paths. */
export interface BashScript {
  scriptContent: string;
  scriptName: string;
}

/** Single-quote a value for safe embedding in generated bash (escapes embedded quotes). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A bash array assignment for the frozen git invocation: `git` plus the frozen
 * `-c` args, and, when given, `--attr-source=<sha>`. An array (not a plain
 * variable) keeps the quotes intact through expansion and keeps an untrusted
 * sha out of the command line. Both script builders that call git in the
 * clone use it; the mother-repo probes use it without the attribute pin.
 */
function frozenGitArray(attrSha?: string): string {
  const attr = attrSha === undefined ? '' : `${shQuote(`--attr-source=${attrSha}`)} `;
  const config = FROZEN_GIT_CONFIG.split(' ').map(shQuote).join(' ');
  return `(git ${attr}${config})`;
}

/**
 * ⊆ write_scope check with directory-prefix semantics: a scope entry ending
 * in `/` matches any changed path under that directory; an entry without a
 * trailing slash matches only that exact path (spec §5's `write_scope`
 * example mixes both: a directory prefix and an exact test-file path).
 *
 * Scope ENTRIES are normalized (a declared `src\\` still reads as `src/`),
 * but a changed path is compared exactly as git lists it. A backslash is a
 * legal filename character on Linux, so rewriting it to `/` would let a
 * tracked file named `src\x` masquerade as `src/x` and pass a `src/` scope.
 */
export function checkWriteScope(
  changedFiles: string[],
  writeScope: string[],
): { ok: true } | { ok: false; offendingPaths: string[] } {
  const normalizedScope = writeScope.map((entry) => entry.replace(/\\/g, '/'));

  const isInScope = (file: string): boolean =>
    normalizedScope.some((entry) => {
      if (entry.endsWith('/')) {
        return file === entry.slice(0, -1) || file.startsWith(entry);
      }
      return file === entry;
    });

  const offendingPaths = changedFiles.filter((file) => !isInScope(file));
  if (offendingPaths.length > 0) return { ok: false, offendingPaths };
  return { ok: true };
}

interface SecretPattern {
  name: string;
  regex: RegExp;
}

// S0 subset: pattern-only. S3 adds injected-value scanning (the launcher's
// own known secret_env values), per spec §8.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'aws_access_key_id', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'bearer_token', regex: /[Bb]earer\s+[A-Za-z0-9\-._~+\/]+=*/ },
  { name: 'pem_private_key', regex: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/ },
  { name: 'sk_style_api_key', regex: /sk-[a-zA-Z0-9]{20,}/ },
];

/** Pattern-only secret scan over a diff (S0 subset of spec §8's `secret_in_diff` check). */
export function scanSecrets(diff: string): { ok: true } | { ok: false; patterns: string[] } {
  const patterns = SECRET_PATTERNS.filter((p) => p.regex.test(diff)).map((p) => p.name);
  if (patterns.length > 0) return { ok: false, patterns };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stage -> check -> land over ONE tree.
//
// The implement branch stages the worker's clone once into a temp index
// seeded from `BASE_SHA`, with `--attr-source=<ATTR_SHA>` on every in-clone
// git call, writes the raw NUL listing and the ignored-in-scope list to files
// in a host-created temp dir, and prints a strict stdout grammar. TypeScript
// parses that one staged tree, checks it (gitlinks -> write_scope -> value
// scan), and only then hands exactly the checked `TREE` to the land script.
// The advisory branch reuses the same stage script with an empty scope and no
// skeleton paths, for mutation detection only — it never reaches land.
// ---------------------------------------------------------------------------

/** Temp-dir prefix for the stage script's listing files (under `os.tmpdir()`). */
export const STAGE_TEMP_PREFIX = 'kb-stage-';
/** Raw `diff-tree -r -z --raw --no-renames` listing file written by the stage script. */
export const STAGE_RAW_LISTING_FILENAME = 'stage-raw-listing.z';
/** `ls-files -z --others -i --exclude-standard` listing file written by the stage script. */
export const STAGE_IGNORED_FILENAME = 'stage-ignored.z';

/** `TREE <40 or 64 hex>` — the one required line of the stage stdout grammar. */
const STAGE_TREE_LINE = /^TREE ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/;
/** Strict `diff-tree --raw -z` header: `:<6 octal> <6 octal> <hex> <hex> <A|D|M|T>` then one NUL-terminated path. */
const STAGE_RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/;
const STAGE_SECRET_HIT = /^SECRET_HIT=(.+)$/;
/** Git object id in either the SHA-1 or SHA-256 object format. */
const GIT_SHA = '(?:[0-9a-f]{40}|[0-9a-f]{64})';

export interface StageScriptOpts {
  clonePath: string;
  baseSha: string;
  /** Mother `HEAD` at admission — the `--attr-source` commit, never a chained `base_ref`. */
  attrSha: string;
  /** Host-created temp dir the two listing files are written into. */
  stageDir: string;
  /** Unwidened `handoff.write_scope`, used only to scope the ignored list. */
  writeScope: string[];
  /** skeleton paths this run created (untouched-skeleton drop). */
  skeletonPaths?: string[];
  /** `buildInjectedValueScanFragment` lines, spliced after TREE; empty when no credentials. */
  valueScanLines?: string[];
}

/**
 * Stage script: seed a temp index from `BASE_SHA`, stage the clone's full
 * working-tree delta, drop untouched 0-byte write_scope skeletons created in
 * this run, `write-tree` -> TREE, then write the raw NUL listing and the
 * ignored-in-scope list into the host-created `stageDir`. Never reads the
 * worktree beyond `git add -A`/`git ls-files`, and never touches the real
 * index. Under `set -euo pipefail` with no `|| true` on a git call.
 */
export function buildStageScript(opts: StageScriptOpts): BashScript {
  const { clonePath, baseSha, attrSha, stageDir, writeScope } = opts;
  const rawListingPath = join(stageDir, STAGE_RAW_LISTING_FILENAME);
  const ignoredPath = join(stageDir, STAGE_IGNORED_FILENAME);
  const skeletonPaths = opts.skeletonPaths ?? [];
  const skeletonPathsArrayLine = skeletonPaths.length === 0
    ? 'SKELETON_PATHS=()'
    : `SKELETON_PATHS=(${skeletonPaths.map(shQuote).join(' ')})`;
  const ignoredPathspec = writeScope.length === 0 ? '' : ` -- ${writeScope.map(shQuote).join(' ')}`;
  const valueScanLines = opts.valueScanLines ?? [];
  const valueScanBlock = valueScanLines.length === 0
    ? ''
    : [
        'DIFF_FILE="$STAGE_DIR/stage.diff"',
        `"\${GIT[@]}" diff --text --no-renames "$BASE_SHA" "$TREE" > "$DIFF_FILE"`,
        ...valueScanLines,
        'rm -f "$DIFF_FILE"',
      ].join('\n');

  const scriptContent = `#!/bin/bash
set -euo pipefail

CLONE_PATH=${shQuote(clonePath)}
BASE_SHA=${shQuote(baseSha)}
STAGE_DIR=${shQuote(stageDir)}
RAW_LISTING_FILE=${shQuote(rawListingPath)}
IGNORED_FILE=${shQuote(ignoredPath)}

GIT=${frozenGitArray(attrSha)}

DELIVERY_IDX=$(mktemp "$STAGE_DIR/dispatch-stage-idx.XXXXXX")
export GIT_INDEX_FILE="$DELIVERY_IDX"
export GIT_COMMITTER_NAME="kb-dispatch"
export GIT_COMMITTER_EMAIL="dispatch@kb.local"
export GIT_AUTHOR_NAME="kb-dispatch"
export GIT_AUTHOR_EMAIL="dispatch@kb.local"

cd "$CLONE_PATH"

# One tree: seed the temp index from base_sha (never the real index) and
# stage the full worktree delta (modified + untracked + deleted) into it.
"\${GIT[@]}" read-tree "$BASE_SHA"
"\${GIT[@]}" add -A

# Worker writes blocked by .gitignore are named out loud rather than silently
# dropped — NUL-delimited so a path with a newline survives.
"\${GIT[@]}" ls-files -z --others -i --exclude-standard${ignoredPathspec} > "$IGNORED_FILE"

# Untouched-skeleton drop: only a path this run created, whose blob is
# still the canonical empty blob, is removed.
${skeletonPathsArrayLine}
EMPTY_BLOB="e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
is_skeleton_path() {
  local target="$1"
  local sp
  for sp in "\${SKELETON_PATHS[@]}"; do
    if [ "$sp" = "$target" ]; then
      return 0
    fi
  done
  return 1
}
"\${GIT[@]}" ls-files -s | while IFS= read -r ENTRY; do
  ENTRY_HASH=$(printf '%s' "$ENTRY" | cut -d' ' -f2)
  ENTRY_PATH=$(printf '%s' "$ENTRY" | cut -f2)
  if [ "$ENTRY_HASH" = "$EMPTY_BLOB" ] && is_skeleton_path "$ENTRY_PATH"; then
    "\${GIT[@]}" update-index --force-remove -- "$ENTRY_PATH"
  fi
done

TREE=$("\${GIT[@]}" write-tree)
BASE_TREE=$("\${GIT[@]}" rev-parse "$BASE_SHA^{tree}")
rm -f "$DELIVERY_IDX"

echo "TREE $TREE"
if [ "$TREE" = "$BASE_TREE" ]; then
  echo "NO_DELTA"
fi

# Raw NUL listing of the checked tree — the stage parser reads it as a file,
# never as stdout.
"\${GIT[@]}" diff-tree -r -z --raw --no-renames "$BASE_SHA" "$TREE" > "$RAW_LISTING_FILE"
${valueScanBlock}
`;

  return { scriptContent, scriptName: 'dispatch-stage.sh' };
}

export interface StageResult {
  tree: string;
  noDelta: boolean;
  /** Every path in the raw listing (both ends of a rename included). */
  changedFiles: string[];
  /** Every path whose old or new mode is a submodule gitlink (`160000`). */
  gitlinkPaths: string[];
  ignoredFiles: string[];
  /** `SECRET_HIT=<NAME>` names, in emitted order. */
  secretHits: string[];
}

export type StageParseResult = { ok: true; stage: StageResult } | { ok: false; message: string };

function stageFailure(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/** Split a Buffer on NUL bytes, dropping only the empty tail a final NUL leaves behind. */
function splitNulBuffer(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

/** Fatal UTF-8 decode; refuses replacement characters (a lossy decode must fail closed). */
function decodeUtf8Strict(buf: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (text.includes('\uFFFD')) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Read one `git -z` listing file as a Buffer, refusing a missing, over-cap or
 * not-NUL-terminated (truncated) file. Every error fails closed — the caller
 * never distinguishes "absent" from "unreadable".
 */
async function readListingFile(path: string): Promise<{ ok: true; data: Buffer } | { ok: false; message: string }> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return stageFailure('A stage listing file could not be read.');
  }
  if (size > MAX_BUFFER_BYTES) return stageFailure('A stage listing file exceeded the maximum size.');
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    return stageFailure('A stage listing file could not be read.');
  }
  if (data.length > MAX_BUFFER_BYTES) return stageFailure('A stage listing file exceeded the maximum size.');
  if (data.length > 0 && data[data.length - 1] !== 0) {
    return stageFailure('A stage listing file was truncated.');
  }
  return { ok: true, data };
}

/**
 * Parse the stage script's strict stdout grammar — exactly one `TREE <hex>`
 * line, at most one `NO_DELTA`, zero or more `SECRET_HIT=<NAME>` lines whose
 * NAME matches `ENV_NAME`, nothing else — plus the two NUL listing files. Any
 * deviation, an undecodable path, a malformed/truncated record or an over-cap
 * file fails closed; the messages name no file content.
 */
export async function parseStageOutput(
  stdout: string,
  rawListingPath: string,
  ignoredPath: string,
): Promise<StageParseResult> {
  const normalized = stdout.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let tree: string | undefined;
  let noDelta = false;
  const secretHits: string[] = [];
  for (const line of lines) {
    const treeMatch = line.match(STAGE_TREE_LINE);
    if (treeMatch) {
      if (tree !== undefined) return stageFailure('Stage output repeated the TREE line.');
      tree = treeMatch[1]!;
      continue;
    }
    if (line === 'NO_DELTA') {
      if (noDelta) return stageFailure('Stage output repeated the NO_DELTA line.');
      noDelta = true;
      continue;
    }
    const secretMatch = line.match(STAGE_SECRET_HIT);
    if (secretMatch) {
      const name = secretMatch[1]!;
      if (!ENV_NAME.test(name)) return stageFailure('Stage output named a secret with an invalid variable name.');
      secretHits.push(name);
      continue;
    }
    return stageFailure('Stage output contained a line outside its grammar.');
  }
  if (tree === undefined) return stageFailure('Stage output contained no TREE line.');

  const rawListing = await readListingFile(rawListingPath);
  if (!rawListing.ok) return rawListing;
  const ignoredListing = await readListingFile(ignoredPath);
  if (!ignoredListing.ok) return ignoredListing;

  const rawParts = splitNulBuffer(rawListing.data);
  if (rawParts.length % 2 !== 0) return stageFailure('The raw listing ended in an incomplete record.');

  const changedFiles: string[] = [];
  const gitlinkPaths: string[] = [];
  for (let i = 0; i < rawParts.length; i += 2) {
    const header = decodeUtf8Strict(rawParts[i]!);
    const path = decodeUtf8Strict(rawParts[i + 1]!);
    if (header === null || path === null) return stageFailure('A listing path was not valid UTF-8.');
    const record = header.match(STAGE_RAW_RECORD);
    if (!record) return stageFailure('The raw listing contained a malformed record header.');
    changedFiles.push(path);
    if (record[1] === '160000' || record[2] === '160000') gitlinkPaths.push(path);
  }

  const ignoredFiles: string[] = [];
  for (const part of splitNulBuffer(ignoredListing.data)) {
    const path = decodeUtf8Strict(part);
    if (path === null) return stageFailure('An ignored-list path was not valid UTF-8.');
    ignoredFiles.push(path);
  }

  return { ok: true, stage: { tree, noDelta, changedFiles, gitlinkPaths, ignoredFiles, secretHits } };
}

/**
 * The one place the check order lives: `NO_DELTA` first, then any gitlink on
 * either side (a nested
 * repo's contents are not paths of this tree, so a gitlink would otherwise
 * slip past `checkWriteScope`), then `checkWriteScope` over every listed
 * path, then the injected-value verdict. Pure and exported so the pipeline
 * and its tests share one decision, never two.
 */
export type StageVerdict =
  | { kind: 'no_delta' }
  | { kind: 'gitlink'; offendingPaths: string[] }
  | { kind: 'out_of_scope'; offendingPaths: string[] }
  | { kind: 'secret_in_diff'; patterns: string[] }
  | { kind: 'clean' };

export function classifyStage(stage: StageResult, writeScope: string[]): StageVerdict {
  if (stage.noDelta) return { kind: 'no_delta' };
  if (stage.gitlinkPaths.length > 0) return { kind: 'gitlink', offendingPaths: stage.gitlinkPaths };
  const scopeCheck = checkWriteScope(stage.changedFiles, writeScope);
  if (!scopeCheck.ok) return { kind: 'out_of_scope', offendingPaths: scopeCheck.offendingPaths };
  if (stage.secretHits.length > 0) return { kind: 'secret_in_diff', patterns: stage.secretHits };
  return { kind: 'clean' };
}

export interface StageRunOpts {
  clonePath: string;
  baseSha: string;
  attrSha: string;
  writeScope: string[];
  skeletonPaths?: string[];
  valueScanLines?: string[];
}

export type StageRunResult = { ok: true; stage: StageResult } | { ok: false; message: string };

/**
 * The one stage helper: `mkdtemp` a `kb-stage-` dir under `os.tmpdir()`, run
 * the stage script, parse it, and remove the dir in a `finally` on every
 * path. The pipeline checks the exit code before it ever parses, so a stage
 * that fails after printing TREE never reaches check or land. The advisory
 * branch reuses this with an empty scope and no skeleton paths.
 */
export async function runStageScript(opts: StageRunOpts): Promise<StageRunResult> {
  let stageDir: string;
  try {
    stageDir = await mkdtemp(join(tmpdir(), STAGE_TEMP_PREFIX));
  } catch {
    return stageFailure('Failed to create the stage temp directory.');
  }

  try {
    const script = buildStageScript({ ...opts, stageDir });
    const exec = await execBash({ scriptContent: script.scriptContent, timeoutMs: 120_000 });
    if (!exec.ok) return stageFailure('Stage script failed to run.');
    if (exec.data.exitCode !== 0) {
      return stageFailure(`Stage script exited with code ${exec.data.exitCode}.`);
    }
    return await parseStageOutput(
      exec.data.stdout,
      join(stageDir, STAGE_RAW_LISTING_FILENAME),
      join(stageDir, STAGE_IGNORED_FILENAME),
    );
  } finally {
    // Temp-dir cleanup is best-effort: the staging verdict was already
    // decided above, and a failure to remove scratch space must not turn a
    // parsed stage into a failure (nor mask one). The failure is logged with
    // its cause rather than silently dropped.
    try {
      await rm(stageDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`kb-dispatch: failed to remove stage temp dir ${stageDir}:`, err);
    }
  }
}

export interface LandScriptOpts {
  clonePath: string;
  motherRepoWsl: string;
  handoffId: string;
  baseSha: string;
  attrSha: string;
  /** The checked TREE from `parseStageOutput` (already validated 40/64-hex). */
  tree: string;
}

export type LandOutcome =
  | { status: 'delivered'; commitSha: string }
  | { status: 'idempotent' }
  | { status: 'conflict'; existingTree: string };

export type LandParseResult = { ok: true; outcome: LandOutcome } | { ok: false; message: string };

/**
 * Land script: `commit-tree TREE -p BASE_SHA` with the pinned identity, then
 * the existing CAS push onto `refs/heads/dispatch/<handoffId>` — same tree
 * from the same base is idempotent, a different tree is a structured
 * conflict, never a clobber. Prints exactly one line (`DELIVERED:<sha>`,
 * `IDEMPOTENT`, or `CONFLICT:<tree>`); push stdout is discarded so nothing
 * else can reach that stream. `commit-tree` and `push` carry
 * `--attr-source`; the mother-repo probes carry the same `-c` values only.
 */
export function buildLandScript(opts: LandScriptOpts): BashScript {
  const { clonePath, motherRepoWsl, handoffId, baseSha, attrSha, tree } = opts;
  const scriptContent = `#!/bin/bash
set -euo pipefail

CLONE_PATH=${shQuote(clonePath)}
MOTHER_REPO=${shQuote(motherRepoWsl)}
HANDOFF_ID=${shQuote(handoffId)}
BASE_SHA=${shQuote(baseSha)}
TREE=${shQuote(tree)}

GIT=${frozenGitArray(attrSha)}
GIT_MOTHER=${frozenGitArray()}

export GIT_COMMITTER_NAME="kb-dispatch"
export GIT_COMMITTER_EMAIL="dispatch@kb.local"
export GIT_AUTHOR_NAME="kb-dispatch"
export GIT_AUTHOR_EMAIL="dispatch@kb.local"

cd "$CLONE_PATH"

COMMIT=$("\${GIT[@]}" commit-tree "$TREE" -p "$BASE_SHA" -m "dispatch: $HANDOFF_ID")

EXISTING_REF=$("\${GIT_MOTHER[@]}" -C "$MOTHER_REPO" rev-parse --verify "refs/heads/dispatch/$HANDOFF_ID" 2>/dev/null || echo "NONE")

if [ "$EXISTING_REF" = "NONE" ]; then
  "\${GIT[@]}" push "$MOTHER_REPO" "$COMMIT:refs/heads/dispatch/$HANDOFF_ID" >/dev/null
  echo "DELIVERED:$COMMIT"
else
  EXISTING_TREE=$("\${GIT_MOTHER[@]}" -C "$MOTHER_REPO" rev-parse --verify "refs/heads/dispatch/$HANDOFF_ID^{tree}" 2>/dev/null || echo "")
  EXISTING_PARENT=$("\${GIT_MOTHER[@]}" -C "$MOTHER_REPO" rev-parse --verify "refs/heads/dispatch/$HANDOFF_ID^" 2>/dev/null || echo "")
  if [ "$EXISTING_TREE" = "$TREE" ] && [ "$EXISTING_PARENT" = "$BASE_SHA" ]; then
    echo "IDEMPOTENT"
  else
    echo "CONFLICT:$EXISTING_TREE"
  fi
fi
`;

  return { scriptContent, scriptName: 'dispatch-land.sh' };
}

/** Parse the land script's one-line grammar; anything else fails closed. */
export function parseLandOutput(stdout: string): LandParseResult {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== 1) return { ok: false, message: 'Land output did not contain exactly one line.' };

  const line = lines[0]!;
  if (line === 'IDEMPOTENT') return { ok: true, outcome: { status: 'idempotent' } };
  const delivered = line.match(new RegExp(`^DELIVERED:(${GIT_SHA})$`));
  if (delivered) return { ok: true, outcome: { status: 'delivered', commitSha: delivered[1]! } };
  const conflict = line.match(new RegExp(`^CONFLICT:(${GIT_SHA})$`));
  if (conflict) return { ok: true, outcome: { status: 'conflict', existingTree: conflict[1]! } };
  return { ok: false, message: 'Land output did not match DELIVERED, IDEMPOTENT, or CONFLICT.' };
}

export interface QuarantineScriptOpts {
  clonePath: string;
  baseSha: string;
  attrSha: string;
  tree: string;
}

/**
 * The one extra exec a refusal runs: `git diff --no-renames BASE_SHA TREE`
 * (tree to tree, no worktree read), captured under `MAX_BUFFER_BYTES` by
 * `execBash` and written to `quarantine.diff` by the pipeline. Emits only the
 * diff on stdout.
 */
export function buildQuarantineScript(opts: QuarantineScriptOpts): BashScript {
  const { clonePath, baseSha, attrSha, tree } = opts;
  const scriptContent = `#!/bin/bash
set -euo pipefail

CLONE_PATH=${shQuote(clonePath)}
BASE_SHA=${shQuote(baseSha)}
TREE=${shQuote(tree)}

GIT=${frozenGitArray(attrSha)}

cd "$CLONE_PATH"
"\${GIT[@]}" diff --no-renames "$BASE_SHA" "$TREE"
`;

  return { scriptContent, scriptName: 'dispatch-quarantine.sh' };
}
