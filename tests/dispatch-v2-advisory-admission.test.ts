/**
 * WK-0272 — admission's dirty gate and uncommitted declared inputs.
 * Proves: an advisory HO (empty write_scope) is admitted with kb's own
 * uncommitted outputs in the tree (a fresh HO, wiki/.id-state.json, another
 * session's stamp edit) through the real create-handoff / derive-review ->
 * runDispatch path; base drift on a declared read_first file still refuses;
 * an uncommitted read_first input refuses UNCOMMITTED_READ_FIRST before the
 * base-drift check, naming the files and the remedy for its chain position
 * (DEC-0047 A2 R9), in both wiki shapes. Temp dirs only (WK-0043).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { deriveReview } from '../packages/dispatch-core/src/derive-review.js';
import type { Handoff } from '../packages/dispatch-core/src/ho.js';
import { runDispatch } from '../packages/dispatch-core/src/pipeline.js';
import { restamp } from '../packages/dispatch-core/src/restamp.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';

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

const WK_BODY = '---\nid: "WK-9272"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9272\n---\n\n# WK-9272: Fixture\n';

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-9272',
    title: 'Advisory admission fixture',
    mode: 'explore_code',
    write_scope: [],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    runtime_envs: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['read only'],
    status: 'draft',
    ...overrides,
  };
}

describe('WK-0272 admission — tracked wiki', () => {
  let repo: string;
  let stampSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-advisory-admission-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'other.md'), 'unrelated\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9272.md'), WK_BODY);
    stampSha = commitAll(repo, 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: kb's own outputs sit uncommitted between create-handoff and dispatch; they must not block an advisory HO.
  it('admits an advisory HO with dirty and untracked files outside its declared paths', async () => {
    await writeFile(join(repo, 'docs', 'other.md'), 'edited, not committed\n');
    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'handoffs', 'HO-9272.md'), 'fresh HO, not committed\n');
    await writeFile(join(repo, 'wiki', '.id-state.json'), '{}\n');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: skipping the dirty scan must not remove the staleness guard on what the worker reads (HO-0216 F8).
  it('still refuses BASE_DRIFT when a declared read_first file changed since the stamp', async () => {
    await writeFile(join(repo, 'README.md'), '# changed\n');
    commitAll(repo, 'touch readme');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.detail).toMatchObject({ changed: ['README.md'] });
  });

  // Why: the clone is cut from a commit, so an uncommitted read_first edit never reaches the worker (A2 R9).
  it('refuses an uncommitted read_first edit with the commit-then-restamp remedy for a fresh-HEAD HO', async () => {
    await writeFile(join(repo, 'README.md'), '# edited, not committed\n');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.message).toContain('README.md');
    expect(result.message).toContain('restamp');
    expect(result.detail).toEqual({ uncommitted: ['README.md'], remedy: 'commit_then_restamp' });
  });

  // Why: a never-committed file named in read_first is just as invisible to the clone.
  it('names every untracked file under a read_first directory', async () => {
    await mkdir(join(repo, 'docs', 'new'), { recursive: true });
    await writeFile(join(repo, 'docs', 'new', 'a.md'), 'a\n');
    await writeFile(join(repo, 'docs', 'new', 'b.md'), 'b\n');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha, read_first: ['docs/'] }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.detail).toMatchObject({ uncommitted: ['docs/new/a.md', 'docs/new/b.md'] });
  });

  // Why: the printed remedy must actually clear the refusal — a commit alone trips BASE_DRIFT (WK-0152 decision 4).
  it('admits after the compound remedy: commit, then restamp', async () => {
    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    const hoPath = 'wiki/handoffs/HO-9272.md';
    await writeFile(
      join(repo, hoPath),
      `---\nid: HO-9272\ntitle: Remedy fixture\nmode: explore_code\nwrite_scope: []\nbase_ref: null\nbase_sha: "${stampSha}"\nweb: false\ncredentials: []\ndata_mounts: []\nread_first: ["README.md"]\nacceptance:\n  - "AC-1: example"\nvalidation: ["read only"]\nstatus: draft\n---\n\nBody.\n`,
    );
    await writeFile(join(repo, 'README.md'), '# edited, not committed\n');
    expect((await checkAdmission(makeHandoff({ base_sha: stampSha }), repo)).ok).toBe(false);

    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'commit the input');
    const afterCommit = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(afterCommit.ok).toBe(false);
    if (afterCommit.ok) return;
    expect(afterCommit.error).toBe('BASE_DRIFT');

    const stamped = await restamp({ dir: repo, handoff: hoPath });
    expect(stamped.ok).toBe(true);
    if (!stamped.ok) return;
    const result = await checkAdmission(makeHandoff({ base_sha: stamped.data.base_sha }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: a chained HO has no stamp to refresh, so its remedy is one commit.
  it('refuses an uncommitted wiki read_first input of a chained HO with the single-commit remedy', async () => {
    git(repo, 'branch', 'dispatch/HO-9000');
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9272.md'), 'edited, not committed\n');
    const result = await checkAdmission(
      makeHandoff({ base_ref: 'dispatch/HO-9000', read_first: ['wiki/issues/WK-9272.md'] }),
      repo,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.message).not.toContain('restamp --handoff');
    expect(result.detail).toEqual({ uncommitted: ['wiki/issues/WK-9272.md'], remedy: 'commit' });
  });
});

describe('WK-0272 admission — nested-private wiki', () => {
  let repo: string;
  let wikiDir: string;
  let stampSha: string;
  let wikiSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-advisory-admission-nested-'));
    initRepo(repo);
    await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    wikiDir = join(repo, 'wiki');
    await mkdir(join(wikiDir, 'issues'), { recursive: true });
    await writeFile(join(wikiDir, 'issues', 'WK-9272.md'), WK_BODY);
    stampSha = commitAll(repo, 'init');
    initRepo(wikiDir);
    wikiSha = commitAll(wikiDir, 'wiki init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: the live wiki bind shows dirty bytes no commit records; R9 refuses before base drift names the wrong fix.
  it('refuses an uncommitted wiki read_first input as UNCOMMITTED_READ_FIRST, not BASE_DRIFT', async () => {
    await writeFile(join(wikiDir, 'issues', 'WK-9272.md'), 'edited, not committed\n');
    const result = await checkAdmission(
      makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha, read_first: ['README.md', 'wiki/issues/WK-9272.md'] }),
      repo,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.message).toContain('git -C wiki commit');
    expect(result.message).toContain('restamp');
    expect(result.detail).toEqual({ uncommitted: ['wiki/issues/WK-9272.md'], remedy: 'commit_then_restamp' });
  });

  // Why: the code-repo half of a nested repo is checked too.
  it('refuses an uncommitted code-repo read_first input in the nested shape', async () => {
    await writeFile(join(repo, 'README.md'), '# edited, not committed\n');
    const result = await checkAdmission(
      makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha, read_first: ['README.md', 'wiki/issues/WK-9272.md'] }),
      repo,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.detail).toMatchObject({ uncommitted: ['README.md'] });
  });

  // Why: a chained nested-private HO newly refuses dirty inputs it could see through the live bind (A2 R9 provenance ruling).
  it('refuses a chained HO with an uncommitted wiki input, single-commit remedy', async () => {
    git(repo, 'branch', 'dispatch/HO-9000');
    await writeFile(join(wikiDir, 'issues', 'WK-9272.md'), 'edited, not committed\n');
    const result = await checkAdmission(
      makeHandoff({ base_ref: 'dispatch/HO-9000', read_first: ['wiki/issues/WK-9272.md'] }),
      repo,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.detail).toEqual({ uncommitted: ['wiki/issues/WK-9272.md'], remedy: 'commit' });
  });
});

function implementOpts(dir: string, overrides: Partial<CreateHandoffOpts> = {}): CreateHandoffOpts {
  return {
    dir,
    title: 'Full-path fixture',
    subject: 'kb:dispatch',
    allowed_agents: ['claude'],
    mode: 'implement',
    work_item: 'WK-9272',
    write_scope: ['src/'],
    read_first: ['README.md'],
    acceptance: ['AC-1: example'],
    validation: ['true'],
    ...overrides,
  };
}

const DISPATCH_OPTS = { model: 'deepseek', backend: 'openrouter', effort: 'high', preflight: false } as const;

/**
 * runDispatch refuses EFFORT_UNSUPPORTED right after admission for a model with
 * no effort mapping (the dispatch-v2-base-drift.test.ts pattern), so that code
 * proves admission passed without launching a worker.
 */
async function dispatchToAdmission(repo: string, handoff: string) {
  return runDispatch({ dir: repo, handoff, ...DISPATCH_OPTS });
}

describe('WK-0272 full path — create/derive then dispatch with no manual commit', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-advisory-fullpath-'));
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9272.md'), WK_BODY);
    await writeFile(
      join(repo, 'wiki', '.dispatch', 'models.json'),
      JSON.stringify({ deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731' } }, null, 2),
    );
    await writeFile(
      join(repo, 'wiki', '.dispatch', 'backends.json'),
      JSON.stringify(
        { openrouter: { family: 'pi', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', secrets_file: null } },
        null,
        2,
      ),
    );
    await writeFile(join(repo, 'wiki', '.dispatch', 'profiles.json'), JSON.stringify({ schema_version: 1 }, null, 2));
    initRepo(repo);
    commitAll(repo, 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: the operator report — every advisory dispatch needed a manual commit of what create-handoff just wrote,
  // and two parallel sessions' uncommitted stamps blocked each other.
  it('create-handoff -> dispatch of an advisory HO is admitted with the tool outputs and a parallel stamp uncommitted', async () => {
    const other = await createHandoff(implementOpts(repo));
    if (!other.ok) throw new Error(other.message);
    commitAll(repo, 'parallel session HO');
    // The parallel session's dispatch stamp: an uncommitted edit to its own HO file.
    const otherContent = await readFile(other.data.handoffPath, 'utf8');
    await writeFile(other.data.handoffPath, otherContent.replace('status: draft', 'status: dispatched'));

    const created = await createHandoff(implementOpts(repo, { mode: 'code_review', write_scope: [], work_item: undefined }));
    if (!created.ok) throw new Error(created.message);
    const dirty = git(repo, 'status', '--porcelain');
    expect(dirty).toContain(created.data.handoffRelativePath);
    expect(dirty).toContain('wiki/.id-state.json');

    const result = await dispatchToAdmission(repo, created.data.handoffRelativePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('EFFORT_UNSUPPORTED');
  });

  // Why: derive-review writes the review HO and id-state; the review dispatch must not need a commit in between.
  it('derive-review -> dispatch of the derived review is admitted with no manual commit', async () => {
    const implement = await createHandoff(implementOpts(repo));
    if (!implement.ok) throw new Error(implement.message);
    await writeFile(
      join(repo, 'wiki', 'handoffs', `${implement.data.handoffId}.response.md`),
      `---\nhandoff_id: ${implement.data.handoffId}\noutcome: delivered\n---\n\n# Response\n`,
    );
    commitAll(repo, 'implement delivered');
    git(repo, 'branch', `dispatch/${implement.data.handoffId}`);

    const derived = await deriveReview({ dir: repo, handoff_id: implement.data.handoffId });
    if (!derived.ok) throw new Error(derived.message);
    expect(git(repo, 'status', '--porcelain')).toContain(derived.data.reviewRelativePath);

    const result = await dispatchToAdmission(repo, derived.data.reviewRelativePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('EFFORT_UNSUPPORTED');
  });

  // Why: commitArtifacts is best-effort and swallows failures; the uncommitted response it leaves must surface
  // as the typed refusal naming the file and the one-step remedy, not a silent stale read.
  it('a response left uncommitted by a swallowed commitArtifacts failure refuses UNCOMMITTED_READ_FIRST', async () => {
    const implement = await createHandoff(implementOpts(repo));
    if (!implement.ok) throw new Error(implement.message);
    commitAll(repo, 'implement HO');
    git(repo, 'branch', `dispatch/${implement.data.handoffId}`);
    const responsePath = `wiki/handoffs/${implement.data.handoffId}.response.md`;
    await writeFile(join(repo, responsePath), `---\nhandoff_id: ${implement.data.handoffId}\n---\n\n# Response\n`);

    const review = await createHandoff(
      implementOpts(repo, {
        mode: 'code_review',
        write_scope: [],
        base_ref: `dispatch/${implement.data.handoffId}`,
        read_first: [responsePath],
      }),
    );
    if (!review.ok) throw new Error(review.message);

    const result = await dispatchToAdmission(repo, review.data.handoffRelativePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNCOMMITTED_READ_FIRST');
    expect(result.message).toContain(responsePath);
    expect(result.detail).toEqual({ uncommitted: [responsePath], remedy: 'commit' });
  });
});
