/**
 * Post-run artifact auto-commit (WK-0132 Slice 1, DEC-0038). Immediately
 * after the pipeline writes `HO-XXXX.response.md` and merges provenance
 * frontmatter into `HO-XXXX.md` (pipeline.ts's 20b/20c steps), those two
 * paths sit as uncommitted dirt in the mother repo and trip the blanket
 * `DIRTY_REPO` admission check on the next dispatch (`admission.ts`'s
 * `git status --porcelain` gate). `commitArtifacts` commits exactly those
 * two paths — never `add -A`, never a pathless commit — using the same
 * isolated-index git plumbing `delivery.ts`'s `buildDeliveryScript` uses to
 * commit worker code: seed a throwaway index from `HEAD`, stage only the two
 * artifact paths into it, write-tree, commit-tree with the pinned
 * `kb-dispatch` identity, then advance `HEAD`. The real index and working
 * tree are never touched, so concurrent operator edits and staged content
 * are excluded regardless of their state (DEC-0038 isolation contract).
 *
 * Posture: best-effort, matching the write-back steps above it. Any failure
 * (including "not a git repo") is caught, logged via `logVerbose`, and
 * swallowed — this must never fail an otherwise successful run. Nothing to
 * commit (neither path differs from `HEAD`) is a silent no-op, not a warning.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** Mirrors pipeline.ts's local (unexported) `logVerbose` helper. */
function logVerbose(verbose: boolean | undefined, message: string): void {
  if (verbose) process.stderr.write(`[dispatch] ${message}\n`);
}

/**
 * Commit `wiki/handoffs/<handoffId>.response.md` and
 * `wiki/handoffs/<handoffId>.md` to the repo that owns them, on its current
 * branch, using a pinned `kb-dispatch <dispatch@kb.local>` identity and a
 * templated `chore: dispatch <handoffId> <outcome> (<model>)` message.
 *
 * Never throws: every failure path (missing git repo, nothing to stage,
 * commit-tree failure) is either silently no-op'd (nothing to commit) or
 * caught and warned via `logVerbose` (an actual error) — this is a
 * best-effort post-run step, not a gate. `DIRTY_REPO` on the next dispatch
 * stays the fail-loud backstop for anything this can't commit.
 */
export async function commitArtifacts(opts: {
  /** Target repo dir passed to the pipeline (may not itself be the repo root). */
  dir: string;
  /** e.g. "HO-0034". */
  handoffId: string;
  /** Delivery outcome string (e.g. "delivered"). */
  outcome: string;
  /** Canonical model string. */
  model: string;
  verbose?: boolean;
}): Promise<void> {
  const { dir, handoffId, outcome, model, verbose } = opts;
  let indexTmpDir: string | undefined;

  try {
    // Owning repo (DEC-0038 point 5): resolve from the artifact directory,
    // never assume `dir` is itself the repo root.
    const handoffsDir = join(dir, 'wiki', 'handoffs');
    const responsePath = join(handoffsDir, `${handoffId}.response.md`);
    const hoPath = join(handoffsDir, `${handoffId}.md`);

    const { stdout: topLevelOut } = await execFile('git', ['rev-parse', '--show-toplevel'], {
      cwd: handoffsDir,
    });
    const repoRoot = topLevelOut.trim();

    // Cheap pre-check: if neither artifact path has changes, no-op without
    // touching any index at all.
    const { stdout: statusOut } = await execFile(
      'git',
      ['status', '--porcelain', '--', responsePath, hoPath],
      { cwd: repoRoot },
    );
    if (statusOut.trim() === '') return;

    // Isolated-index plumbing (mirrors delivery.ts:buildDeliveryScript): a
    // throwaway index seeded from HEAD, never the real index, so only the
    // two named paths enter the commit regardless of what else is staged or
    // dirty in the working tree.
    indexTmpDir = await mkdtemp(join(tmpdir(), 'kb-dispatch-commit-'));
    const indexFile = join(indexTmpDir, 'index');
    const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };

    await execFile('git', ['read-tree', 'HEAD'], { cwd: repoRoot, env: indexEnv });
    await execFile('git', ['add', '--', responsePath, hoPath], { cwd: repoRoot, env: indexEnv });
    const { stdout: treeOut } = await execFile('git', ['write-tree'], { cwd: repoRoot, env: indexEnv });
    const tree = treeOut.trim();

    const { stdout: headOut } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    const head = headOut.trim();

    const { stdout: headTreeOut } = await execFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot });
    if (tree === headTreeOut.trim()) return; // no-op: staged content matches HEAD exactly

    const message = `chore: dispatch ${handoffId} ${outcome} (${model})`;
    const commitEnv = {
      ...indexEnv,
      GIT_COMMITTER_NAME: 'kb-dispatch',
      GIT_COMMITTER_EMAIL: 'dispatch@kb.local',
      GIT_AUTHOR_NAME: 'kb-dispatch',
      GIT_AUTHOR_EMAIL: 'dispatch@kb.local',
    };
    const { stdout: commitOut } = await execFile(
      'git',
      ['commit-tree', tree, '-p', head, '-m', message],
      { cwd: repoRoot, env: commitEnv },
    );
    const commit = commitOut.trim();

    // Normal advance (not a force-reset) — HEAD moves to the new commit the
    // same way an ordinary commit would.
    await execFile('git', ['update-ref', 'HEAD', commit], { cwd: repoRoot });

    // Sync the real index: the isolated-index commit advanced HEAD but left
    // the real index stale. Without this, `git status` still reports the two
    // paths as dirty and the next dispatch hits DIRTY_REPO.
    await execFile('git', ['reset', 'HEAD', '--', responsePath, hoPath], { cwd: repoRoot });
  } catch (err) {
    logVerbose(verbose, `warning: could not auto-commit dispatch artifacts for ${handoffId}: ${err}`);
  } finally {
    if (indexTmpDir !== undefined) {
      await rm(indexTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
