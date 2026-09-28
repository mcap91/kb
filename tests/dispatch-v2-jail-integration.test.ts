/**
 * WK-0159 — real-bwrap jail integration tests: pipeline.ts's ACTUAL
 * multi-step sequencing (step 9b write_scope skeleton, step 9c nested-private
 * wiki mount-target skeleton, step 12d `buildBwrapPlan`) against a REAL
 * `bwrap` binary and a REAL read-only git clone.
 *
 * Closes the coverage gap that let WK-0088 (worker-infra dir ro-bound, every
 * implement dispatch broken since S5) and WK-0149 (bwrap mkdir on a
 * read-only nested-private clone) ship undetected:
 *   - `dispatch-v2-jail.test.ts` asserts argv/plan SHAPE only, never executes it.
 *   - `dispatch-v2-spawn.test.ts` executes a real child process but against a
 *     fake `bwrap` stand-in script on PATH (deliberately, per its own
 *     DEC-0009 comment) — real sandbox semantics (ro-binds, mount-target
 *     existence, tmpfs) are never exercised.
 *   - `dispatch-v2-enforcement.test.ts`'s live tier runs real bwrap but is
 *     gated behind `KB_DISPATCH_LIVE_TESTS` and does not target the
 *     nested-private mount-target-mkdir sequencing WK-0149 broke.
 *
 * This file drives the EXPORTED skeleton functions
 * (`precreateWriteScopeSkeleton` / `precreateWikiMountSkeleton`, extracted
 * from pipeline.ts by WK-0163) + `buildBwrapPlan` (jail.ts) + a REAL `bwrap`
 * spawn via `spawnIsolated` (the same spawn primitive pipeline.ts itself
 * calls) — never a hand-copied re-implementation of pipeline.ts's own
 * sequencing.
 *
 * Does NOT duplicate WK-0163's own within-root/symlink-traversal coverage
 * (GPT findings 1-2): `tests/dispatch-v2-write-scope-chain.test.ts` already
 * owns those five ancestor-chain scenarios against `validateWriteScopeChain`
 * and `precreateWriteScopeSkeleton` directly, at the unit level, for both the
 * mother repo and the clone call sites. This file only adds the REAL bwrap
 * execution angle: does the jail actually start, can a worker write within
 * write_scope, and is the ro-bound wiki root actually refused.
 *
 * No personal/absolute paths in fixtures (WK-0043 rule) — every path below
 * is a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { precreateWriteScopeSkeleton, precreateWikiMountSkeleton, runDispatch } from '../packages/dispatch-core/src/pipeline.js';
import { buildBwrapPlan } from '../packages/dispatch-core/src/jail.js';
import { spawnIsolated } from '../packages/dispatch-core/src/spawn-isolated.js';
import * as spawnIsolatedModule from '../packages/dispatch-core/src/spawn-isolated.js';
import * as tierModule from '../packages/dispatch-core/src/tier.js';

// ---------------------------------------------------------------------------
// Bwrap availability gate — FUNCTIONAL probe (WK-0159 rewrite plan item 2),
// NOT `which bwrap`: a binary can be installed yet still be kernel-blocked
// (AppArmor's unprivileged-userns restriction on Ubuntu 24.04+ — tier.ts's
// own APPARMOR_REMEDIATION_TEXT). `bwrap --ro-bind / / true` is a harmless,
// read-only, no-op sandbox round trip: it never mutates anything, it only
// proves the kernel will let bwrap construct a namespace at all.
//
// Computed once at module-collection time, synchronously, so
// `describe.skipIf` below can consume a plain boolean — mirrors
// dispatch-v2-spawn.test.ts's own `describe.skipIf(process.platform ===
// 'win32')` convention. Skip posture mirrors dispatch-v2-enforcement.test.ts:
// skip LOUDLY (a real console.warn, printed on every run until it passes),
// never silently.
// ---------------------------------------------------------------------------

function probeBwrapFunctional(): boolean {
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_FUNCTIONAL = probeBwrapFunctional();

if (!BWRAP_FUNCTIONAL) {
  console.warn(
    'SKIPPED: "real bwrap jail integration (WK-0159)" requires a working bwrap ' +
      '(binary installed AND the kernel actually permits it to construct a user ' +
      'namespace — a live `bwrap --ro-bind / / true` round trip failed, not just ' +
      '`which bwrap`). If bwrap is installed but blocked by AppArmor on Ubuntu ' +
      "24.04+, see tier.ts's APPARMOR_REMEDIATION_TEXT for the fix.",
  );
}

// ---------------------------------------------------------------------------
// Shared git fixture helpers (mirrors dispatch-v2-base-drift.test.ts's own
// initRepo/commitAll pattern).
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function initRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function readFixtureFile(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

// ---------------------------------------------------------------------------
// Real bwrap jail integration — both wiki shapes (WK-0159 rewrite plan item 1)
// ---------------------------------------------------------------------------

describe.skipIf(!BWRAP_FUNCTIONAL)('real bwrap jail integration (WK-0159)', () => {
  describe('tracked wiki shape (wiki/ committed in the same repo, mirrors dispatch-v2-base-drift.test.ts)', () => {
    let motherRepo: string;
    let clonePath: string;
    const writeScope = ['src/'];

    beforeEach(async () => {
      motherRepo = await createTempDir('kb-jail-integration-tracked-');
      initRepo(motherRepo);
      await writeFile(join(motherRepo, 'README.md'), '# fixture\n');
      await mkdir(join(motherRepo, 'wiki', 'issues'), { recursive: true });
      await writeFile(join(motherRepo, 'wiki', 'issues', 'WK-9159.md'), '# fixture WK\n');
      commitAll(motherRepo, 'init');

      clonePath = await createTempDir('kb-jail-integration-tracked-clone-');
      // git clone requires an empty (or nonexistent) target -- mkdtemp's
      // freshly-created empty dir satisfies that.
      execFileSync('git', ['clone', motherRepo, clonePath]);

      const skeleton = await precreateWriteScopeSkeleton(writeScope, clonePath);
      if (!skeleton.ok) throw new Error(`fixture precreateWriteScopeSkeleton failed: ${skeleton.message}`);
      await precreateWikiMountSkeleton('tracked', clonePath);
    });

    afterEach(async () => {
      await rm(motherRepo, { recursive: true, force: true });
      await rm(clonePath, { recursive: true, force: true });
    });

    it('starts the jail and lets the worker write a new file within write_scope', async () => {
      const plan = buildBwrapPlan({
        clonePath,
        writeScope,
        wikiShape: 'tracked',
        mode: 'implement',
        command: ['bash', '-c', 'echo hello > src/testfile.txt'],
      });
      const result = await spawnIsolated(plan, { timeoutMs: 10_000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A nonzero bwrap exit here would mean bwrap itself failed to
      // construct the sandbox (a mount error) -- exitCode 0 proves the jail
      // both started AND the inner write succeeded.
      expect(result.data.exitCode).toBe(0);
      expect(existsSync(join(clonePath, 'src', 'testfile.txt'))).toBe(true);
    });

    it('refuses a write into the ro-bound wiki dir (part of the whole-clone ro-bind, not in write_scope)', async () => {
      const plan = buildBwrapPlan({
        clonePath,
        writeScope,
        wikiShape: 'tracked',
        mode: 'implement',
        command: ['bash', '-c', 'echo hello > wiki/testfile.txt'],
      });
      const result = await spawnIsolated(plan, { timeoutMs: 10_000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.exitCode).not.toBe(0);
      expect(result.data.stderr.toLowerCase()).toContain('read-only file system');
      expect(existsSync(join(clonePath, 'wiki', 'testfile.txt'))).toBe(false);
    });
  });

  describe('nested-private wiki shape (wiki/ gitignored, its own repo -- WK-0149 class, mirrors dispatch-v2-base-drift.test.ts)', () => {
    let motherRepo: string;
    let wikiDir: string;
    let clonePath: string;
    const writeScope = ['src/'];

    beforeEach(async () => {
      motherRepo = await createTempDir('kb-jail-integration-nested-');
      // .gitignore must exist before `git add -A`, or git records wiki/ as
      // an embedded gitlink instead of leaving it untracked (mirrors
      // dispatch-v2-base-drift.test.ts's own fixture comment).
      await writeFile(join(motherRepo, '.gitignore'), 'wiki/\n');
      initRepo(motherRepo);
      await writeFile(join(motherRepo, 'README.md'), '# fixture\n');
      commitAll(motherRepo, 'init');

      wikiDir = join(motherRepo, 'wiki');
      await mkdir(join(wikiDir, 'issues'), { recursive: true });
      await writeFile(join(wikiDir, 'issues', 'WK-9159.md'), '# fixture WK\n');
      initRepo(wikiDir);
      commitAll(wikiDir, 'wiki init');

      clonePath = await createTempDir('kb-jail-integration-nested-clone-');
      execFileSync('git', ['clone', motherRepo, clonePath]);
      // Sanity precondition: wiki/ is gitignored in motherRepo, so the clone
      // must NOT carry it -- this is exactly WK-0149's bug scenario (the
      // bwrap mount TARGET does not exist until step 9c creates it).
      expect(existsSync(join(clonePath, 'wiki'))).toBe(false);

      const skeleton = await precreateWriteScopeSkeleton(writeScope, clonePath);
      if (!skeleton.ok) throw new Error(`fixture precreateWriteScopeSkeleton failed: ${skeleton.message}`);
      await precreateWikiMountSkeleton('nested-private', clonePath);
      // Confirms step 9c actually did its job before any bwrap plan is built.
      expect(existsSync(join(clonePath, 'wiki'))).toBe(true);
    });

    afterEach(async () => {
      await rm(motherRepo, { recursive: true, force: true });
      await rm(clonePath, { recursive: true, force: true });
    });

    it('starts the jail with the wiki mount-target pre-created, and lets the worker write within write_scope', async () => {
      const plan = buildBwrapPlan({
        clonePath,
        writeScope,
        wikiShape: 'nested-private',
        motherWikiPath: wikiDir,
        mode: 'implement',
        command: ['bash', '-c', 'echo hello > src/testfile.txt'],
      });
      const result = await spawnIsolated(plan, { timeoutMs: 10_000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.exitCode).toBe(0);
      expect(existsSync(join(clonePath, 'src', 'testfile.txt'))).toBe(true);
    });

    it('refuses a write into the ro-bound mother-wiki mount', async () => {
      const plan = buildBwrapPlan({
        clonePath,
        writeScope,
        wikiShape: 'nested-private',
        motherWikiPath: wikiDir,
        mode: 'implement',
        command: ['bash', '-c', 'echo hello > wiki/testfile.txt'],
      });
      const result = await spawnIsolated(plan, { timeoutMs: 10_000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.exitCode).not.toBe(0);
      expect(result.data.stderr.toLowerCase()).toContain('read-only file system');
      // The REAL mother-repo wiki dir on the host must be untouched -- the
      // clone's mount is a read-only VIEW of it, not a copy a worker could
      // corrupt.
      expect(existsSync(join(wikiDir, 'testfile.txt'))).toBe(false);
    });

    // -----------------------------------------------------------------------
    // RED-VERIFICATION (WK-0159 rewrite plan item 5) -- performed once,
    // manually, LOCALLY on 2026-09-27. NOT committed, NOT encoded as an
    // automated test (that would require neutralizing production code at
    // runtime, which this task's constraints forbid landing):
    //
    //   1. Temporarily edited pipeline.ts's `precreateWikiMountSkeleton` to a
    //      no-op body (kept both params referenced via `void` to satisfy
    //      noUnusedParameters).
    //   2. Re-ran the full file (`npx vitest run tests/dispatch-v2-jail-integration.test.ts`).
    //      3 of 5 tests went red: both nested-private `it`s above, plus the
    //      fake-tier `runDispatch()` wiring test below (its fixture also uses
    //      the nested-private shape) -- all three failed on this file's OWN
    //      `existsSync(<clone>/wiki)` precondition checks (the `beforeEach`
    //      assertion right above this comment, and the wiring test's
    //      `sawWikiDirAtSpawnTime` assertion), since the mkdir this test
    //      depends on no longer ran. The two tracked-shape `it`s in the
    //      sibling describe block above were UNAFFECTED (still green) --
    //      tracked shape never calls the nested-private branch of
    //      `precreateWikiMountSkeleton`.
    //   3. To also confirm the underlying REAL bwrap failure text (not just
    //      this file's own precondition), temporarily commented out that one
    //      `beforeEach` assertion and added a throwaway `console.log` of
    //      `result.data.{stderr,exitCode}` in the "starts the jail..." `it`,
    //      then re-ran just that test. Captured verbatim:
    //        exitCode: 1
    //        stderr: "bwrap: Can't mkdir /tmp/kb-jail-integration-nested-clone-U2DWSd/wiki: Read-only file system\n"
    //      -- byte-for-byte the same failure WK-0149 originally captured
    //      (`bwrap: Can't mkdir <clone>/wiki: Read-only file system`, exit 1).
    //   4. Reverted every temporary edit: the pipeline.ts neutralization, the
    //      commented-out precondition, and the throwaway console.log calls.
    //      `git diff packages/dispatch-core/src/pipeline.ts` showed no
    //      changes and `git status --porcelain` showed only this test file
    //      as untracked before continuing.
    //
    // This reproduces the exact WK-0149 root cause on nested-private tests
    // only, and confirms the CURRENT (unmodified) pipeline.ts -- exercised by
    // every `it` in this file -- is what fixes it.
    // -----------------------------------------------------------------------
  });
});

// ---------------------------------------------------------------------------
// Fake-tier wiring test through runDispatch() itself (WK-0159 rewrite plan
// item 3 / GPT finding 4).
//
// Mocks `spawnIsolated` + `probeBwrap` (tier.ts) so this runs on ANY host,
// with or without real bwrap -- the "real bwrap actually enforces read-only"
// claim is proven separately, above, by the real-bwrap describe block; THIS
// test instead proves `runDispatch()` ITSELF calls the skeleton functions in
// the right order through its own real wiring, not a hand-copied
// re-implementation of its steps (the gap GPT finding 4 flagged in the prior
// attempt: it called the extracted helpers directly, never runDispatch()).
//
// `preflight: false` skips the T27 diagnostic leg (this test cares about
// step 9b/9c/12d/13-14 ordering, not piVersion/AppArmor remediation text --
// dispatch-v2-e2e.test.ts's own dominant convention for wiring tests that
// don't need preflight specifics). `probeBwrap` MUST be mocked regardless of
// the preflight flag, since pipeline.ts's step 4b isolation-route gate runs
// UNCONDITIONALLY (D14: required enforcement, never bare-host) and would
// refuse NO_ISOLATION_ROUTE on any host lacking real bwrap before ever
// reaching the clone/skeleton steps this test targets.
// ---------------------------------------------------------------------------

describe('runDispatch() wiring -- skeleton functions run before plan build/spawn (WK-0159 rewrite plan item 3, fake-tier)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the write_scope dir and the nested-private wiki mount-target already exist on disk by the time spawnIsolated (and, immediately before it in the same synchronous step, buildBwrapPlan) is invoked -- proving steps 9b/9c ran before plan build/spawn, not after or never', async () => {
    const repoRoot = await createTempDir('kb-jail-wiring-repo-');
    try {
      // Nested-private shape (WK-0149's own class) + a write_scope dir that
      // does not yet exist anywhere -- exercises BOTH skeleton functions in
      // one pass.
      await writeFile(join(repoRoot, '.gitignore'), 'wiki/\n');
      initRepo(repoRoot);
      await writeFile(join(repoRoot, 'README.md'), 'kb-jail-wiring-fixture\n');
      commitAll(repoRoot, 'init');

      const wikiDir = join(repoRoot, 'wiki');
      await mkdir(join(wikiDir, 'issues'), { recursive: true });
      await mkdir(join(wikiDir, 'initiatives'), { recursive: true });
      await mkdir(join(wikiDir, 'handoffs'), { recursive: true });
      await mkdir(join(wikiDir, '.dispatch'), { recursive: true });
      await writeFile(
        join(wikiDir, 'issues', 'WK-9159.md'),
        '---\nid: "WK-9159"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9159\n---\n\n# WK-9159: Fixture\n',
      );
      await writeFile(
        join(wikiDir, 'initiatives', 'IN-9159.md'),
        '---\nid: "IN-9159"\ntitle: "Fixture initiative"\nstatus: todo\n---\n\n# IN-9159: Fixture\n',
      );
      await writeFile(
        join(wikiDir, '.dispatch', 'models.json'),
        JSON.stringify({ deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731' } }, null, 2),
      );
      await writeFile(
        join(wikiDir, '.dispatch', 'backends.json'),
        JSON.stringify(
          { openrouter: { family: 'pi', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', secrets_file: null } },
          null,
          2,
        ),
      );
      await writeFile(join(wikiDir, '.dispatch', 'profiles.json'), JSON.stringify({ schema_version: 1 }, null, 2));
      initRepo(wikiDir);
      const wikiSha = commitAll(wikiDir, 'wiki init');
      const headSha = git(repoRoot, 'rev-parse', 'HEAD');

      const hoRelPath = 'wiki/handoffs/HO-9159.md';
      const hoContent = `---
id: HO-9159
title: Jail wiring fixture
mode: implement
write_scope: ["src/"]
base_ref: null
base_sha: "${headSha}"
base_wiki_sha: "${wikiSha}"
web: false
credentials: []
data_mounts: []
read_first: []
vars: []
work_item: WK-9159
acceptance:
  - "AC-1: placeholder -- this HO is never actually dispatched to a real worker"
validation: ["true"]
status: draft
---

## Task
Placeholder fixture. spawnIsolated is mocked below, so no worker ever runs.
`;
      await writeFile(join(repoRoot, hoRelPath), hoContent, 'utf8');

      vi.spyOn(tierModule, 'probeBwrap').mockResolvedValue({
        available: true,
        bwrapVersion: 'bubblewrap 0.9.0 (mocked)',
        unshareUserWorks: true,
        kernelVersion: 'test-kernel',
        usernsSysctl: null,
      });

      let sawWikiDirAtSpawnTime: boolean | undefined;
      let sawWriteScopeDirAtSpawnTime: boolean | undefined;
      let capturedClonePath: string | undefined;
      vi.spyOn(spawnIsolatedModule, 'spawnIsolated').mockImplementation(async (plan, opts) => {
        capturedClonePath = plan.cwd;
        sawWikiDirAtSpawnTime = existsSync(join(plan.cwd, 'wiki'));
        sawWriteScopeDirAtSpawnTime = existsSync(join(plan.cwd, 'src'));
        if (opts?.stdoutLogPath) {
          await writeFile(opts.stdoutLogPath, readFixtureFile('pi-output-vllm-qwen25.jsonl'), 'utf8');
        }
        return {
          ok: true,
          data: {
            stdout: '',
            stderr: '',
            exitCode: 0,
            signal: null,
            truncated: false,
            timedOut: false,
            streamDrainTimedOut: false,
          },
        };
      });

      const result = await runDispatch({
        dir: repoRoot,
        handoff: hoRelPath,
        model: 'deepseek',
        backend: 'openrouter',
        preflight: false,
      });

      expect(capturedClonePath).toBeDefined();
      // The whole point: by the time spawnIsolated (and, immediately before
      // it in the same synchronous try block, buildBwrapPlan) is called,
      // step 9c's mkdir and step 9b's write_scope mkdir must ALREADY have
      // happened -- neither can appear afterward.
      expect(sawWikiDirAtSpawnTime).toBe(true);
      expect(sawWriteScopeDirAtSpawnTime).toBe(true);

      expect(result.ok).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
