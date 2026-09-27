/**
 * WK-0152 — base drift gate. Proves: create-handoff stamps base_sha (+
 * base_wiki_sha in nested-private repos); admission refuses a fresh-HEAD HO
 * whose declared files (write_scope, read_first, its WK) changed since the
 * stamp, with a message naming the fix; the fix works end to end through
 * runDispatch; unrelated commits and chained HOs are never refused; the
 * code_review prompt names the implement delivery branch. Temp dirs only
 * (WK-0043).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { assemblePrompt } from '../packages/dispatch-core/src/assemble.js';
import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { parseHandoff, parseHandoffContent, type Handoff } from '../packages/dispatch-core/src/ho.js';
import { runDispatch } from '../packages/dispatch-core/src/pipeline.js';
import type { CreateHandoffOpts } from '../packages/dispatch-core/src/types.js';
import { probeWikiSource } from '../packages/dispatch-core/src/wiki-source.js';

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

const WK_BODY = '---\nid: "WK-9152"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9152\n---\n\n# WK-9152: Fixture\n';

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-9152',
    title: 'Base drift fixture',
    mode: 'implement',
    work_item: 'WK-9152',
    write_scope: ['src/'],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    export_mounts: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['true'],
    status: 'draft',
    ...overrides,
  };
}

describe('BASE_DRIFT (WK-0152) — tracked wiki (the normal repo shape)', () => {
  let repo: string;
  let stampSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-base-drift-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9152.md'), WK_BODY);
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'other.md'), 'unrelated\n');
    stampSha = commitAll(repo, 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: legacy and hand-written HOs must not dispatch unchecked (decision 5); the message carries the fix.
  it('refuses an HO with no base_sha and prints the current HEAD to stamp', async () => {
    const result = await checkAdmission(makeHandoff(), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('has no valid base_sha');
    expect(result.message).toContain(stampSha);
  });

  // Why: a branch name moves and an unknown commit is not evidence — neither is a stamp.
  it.each(['main', '0'.repeat(40)])('refuses base_sha %s as not a valid stamp', async (value) => {
    const result = await checkAdmission(makeHandoff({ base_sha: value }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('has no valid base_sha');
  });

  // Why: the normal path still admits, and the worker gets HEAD (spec §8).
  it('admits an HO stamped at HEAD', async () => {
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.baseSha).toBe(stampSha);
  });

  // Why: unrelated work must not block (WK-0140 principle), and the worker still gets today's code, not the stamp.
  it('admits after an unrelated commit and resolves baseSha to the new HEAD', async () => {
    await writeFile(join(repo, 'docs', 'other.md'), 'changed\n');
    const newHead = commitAll(repo, 'touch docs');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.baseSha).toBe(newHead);
  });

  // Why: this is the HO-0014 failure — code in the task's write_scope changed after it was written.
  it('refuses when a write_scope file changed, listing the file, the commit, and the new HEAD', async () => {
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    const newHead = commitAll(repo, 'touch app');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('src/app.ts');
    expect(result.message).toContain('touch app');
    expect(result.message).toContain(newHead);
    expect(result.detail).toMatchObject({ field: 'base_sha', changed: ['src/app.ts'] });
  });

  // Why: instructions built on a changed read_first file or ticket may be wrong (decision 3).
  it.each(['README.md', 'wiki/issues/WK-9152.md'])('refuses when declared file %s changed', async (path) => {
    await writeFile(join(repo, path), 'changed\n');
    commitAll(repo, `touch ${path}`);
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.detail).toMatchObject({ field: 'base_sha', changed: [path] });
  });

  // Why: the gate keys on content, not commit noise.
  it('admits when a declared file was changed and then restored', async () => {
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    commitAll(repo, 'change');
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    commitAll(repo, 'restore');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: chained HOs run on an immutable dispatch/ branch, and the orchestrator edits the WK mid-chain by design (decision 8).
  it('never refuses a chained HO, even unstamped and after drift', async () => {
    git(repo, 'branch', 'dispatch/HO-9000');
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    commitAll(repo, 'touch app');
    const result = await checkAdmission(makeHandoff({ base_ref: 'dispatch/HO-9000' }), repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.baseSha).toBe(stampSha);
  });
});

describe('BASE_DRIFT (WK-0152) — nested-private wiki (wiki/ is its own repo)', () => {
  let repo: string;
  let wikiDir: string;
  let stampSha: string;
  let wikiSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-base-drift-nested-'));
    initRepo(repo);
    // .gitignore must exist before `git add -A`, or git records wiki/ as an
    // embedded gitlink and the shape probe reads it as tracked.
    await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    wikiDir = join(repo, 'wiki');
    await mkdir(join(wikiDir, 'issues'), { recursive: true });
    await writeFile(join(wikiDir, 'issues', 'WK-9152.md'), WK_BODY);
    stampSha = commitAll(repo, 'init');
    initRepo(wikiDir);
    wikiSha = commitAll(wikiDir, 'wiki init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: both stamps current is the normal nested case — it must admit.
  it('admits when both stamps are current', async () => {
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha }), repo);
    expect(result.ok).toBe(true);
  });

  // Why: kb's tickets live in the nested repo; an HO unstamped there must not dispatch unchecked (decisions 5, 6).
  it('refuses a missing base_wiki_sha and names the wiki HEAD command', async () => {
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('has no valid base_wiki_sha');
    expect(result.message).toContain('git -C wiki rev-parse HEAD');
    expect(result.message).toContain(wikiSha);
  });

  // Why: a committed ticket change in the wiki repo is drift the code-repo diff cannot see (decision 6).
  it('refuses when the ticket changed in the wiki repo', async () => {
    await writeFile(join(wikiDir, 'issues', 'WK-9152.md'), 'changed\n');
    commitAll(wikiDir, 'touch ticket');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('base_wiki_sha');
    expect(result.message).toContain('issues/WK-9152.md');
    expect(result.message).toContain('touch ticket');
  });

  // Why: the jail binds the live wiki dir (DEC-0039), so the worker would see an uncommitted ticket edit.
  it('refuses an uncommitted ticket edit', async () => {
    await writeFile(join(wikiDir, 'issues', 'WK-9152.md'), 'changed\n');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('Commits: none listed (uncommitted changes or rewritten history)');
  });

  // Why: `git diff` cannot report a never-committed file, but the live bind (DEC-0039) shows it to the worker (decision 9).
  it('refuses a ticket that exists only as an untracked wiki file', async () => {
    await writeFile(join(wikiDir, 'issues', 'WK-9153.md'), WK_BODY.replace(/9152/g, '9153'));
    const result = await checkAdmission(
      makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha, work_item: 'WK-9153' }),
      repo,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('issues/WK-9153.md');
    expect(result.message).toContain('Commits: none listed (uncommitted changes or rewritten history)');
  });

  // Why: code drift is still caught in the nested shape, through base_sha.
  it('refuses when a write_scope file changed in the code repo', async () => {
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    commitAll(repo, 'touch app');
    const result = await checkAdmission(makeHandoff({ base_sha: stampSha, base_wiki_sha: wikiSha }), repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.detail).toMatchObject({ field: 'base_sha', changed: ['src/app.ts'] });
  });
});

describe('probeWikiSource (WK-0152)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-wiki-source-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: normal repos carry the wiki in the code repo, so one stamp covers it.
  it('reports tracked with no wiki head when wiki/ is committed in the repo', async () => {
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9152.md'), WK_BODY);
    commitAll(repo, 'init');
    const result = await probeWikiSource(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ shape: 'tracked', head: null });
  });

  // Why: nested-private repos need the wiki repo's own HEAD for base_wiki_sha.
  it('reports nested-private with the wiki repo HEAD', async () => {
    await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    commitAll(repo, 'init');
    const wikiDir = join(repo, 'wiki');
    await mkdir(join(wikiDir, 'issues'), { recursive: true });
    await writeFile(join(wikiDir, 'issues', 'WK-9152.md'), WK_BODY);
    initRepo(wikiDir);
    const wikiSha = commitAll(wikiDir, 'wiki init');
    const result = await probeWikiSource(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ shape: 'nested-private', head: wikiSha });
  });

  // Why: fail loud instead of stamping nothing when the wiki can't be found.
  it('fails with LOOKUP_FAILED when wiki/ is neither tracked nor present', async () => {
    commitAll(repo, 'init');
    const result = await probeWikiSource(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('LOOKUP_FAILED');
  });
});

function handoffOpts(dir: string, overrides: Partial<CreateHandoffOpts> = {}): CreateHandoffOpts {
  return {
    dir,
    title: 'Stamping fixture',
    subject: 'kb:dispatch',
    allowed_agents: ['claude'],
    mode: 'implement',
    work_item: 'WK-9152',
    write_scope: ['src/'],
    acceptance: ['AC-1: example'],
    validation: ['true'],
    ...overrides,
  };
}

describe('createHandoff stamping (WK-0152)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-stamp-'));
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: stamping is automatic, so the gate adds no authoring toil; a normal repo gets exactly one stamp.
  it('stamps base_sha with HEAD and writes no base_wiki_sha in a tracked repo', async () => {
    initRepo(repo);
    const head = commitAll(repo, 'init');
    const created = await createHandoff(handoffOpts(repo));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const content = await readFile(created.data.handoffPath, 'utf8');
    expect(content).toContain(`base_sha: "${head}"`);
    expect(content).not.toContain('base_wiki_sha');
    const parsed = await parseHandoff(created.data.handoffPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.base_sha).toBe(head);
  });

  // Why: nested-private authoring must stamp BOTH repos, or the wiki gate has nothing to compare (decisions 2, 6).
  it('stamps base_sha and base_wiki_sha in a nested-private repo', async () => {
    await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    initRepo(repo);
    const head = commitAll(repo, 'init');
    const wikiDir = join(repo, 'wiki');
    initRepo(wikiDir);
    const wikiHead = commitAll(wikiDir, 'wiki init');
    const created = await createHandoff(handoffOpts(repo));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const content = await readFile(created.data.handoffPath, 'utf8');
    expect(content).toContain(`base_sha: "${head}"`);
    expect(content).toContain(`base_wiki_sha: "${wikiHead}"`);
    const parsed = await parseHandoff(created.data.handoffPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.base_sha).toBe(head);
    expect(parsed.data.base_wiki_sha).toBe(wikiHead);
  });

  // Why: chained HOs are exempt from the gate, so they carry no stamp.
  it('writes no stamp for a chained HO', async () => {
    initRepo(repo);
    commitAll(repo, 'init');
    const created = await createHandoff(handoffOpts(repo, { base_ref: 'dispatch/HO-0001' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parsed = await parseHandoff(created.data.handoffPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.base_sha).toBeUndefined();
  });

  // Why: fail loud at authoring — an unstamped HO would only be refused later at dispatch.
  it('refuses with LOOKUP_FAILED outside a git repo and writes no HO file', async () => {
    const created = await createHandoff(handoffOpts(repo));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe('LOOKUP_FAILED');
    const files = await readdir(join(repo, 'wiki', 'handoffs'));
    expect(files.filter((f) => /^HO-\d+\.md$/.test(f))).toEqual([]);
  });
});

const REVIEW_HO = `---
id: HO-9153
title: Code review fixture
mode: code_review
write_scope: []
base_ref: dispatch/HO-9152
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: Works"
validation:
  - "npm test"
status: draft
---

The task body text.
`;

describe('code_review framing names the implement delivery (WK-0152)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-framing-'));
    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'handoffs', 'HO-9153.md'), REVIEW_HO, 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: the reviewer must be pointed at the implement HO's delivery branch, not a branch named after the review HO.
  it('points the reviewer at base_ref and the single-commit diff', async () => {
    const parsed = parseHandoffContent(REVIEW_HO, 'HO-9153.md');
    if (!parsed.ok) throw new Error(parsed.message);
    const result = await assemblePrompt(parsed.data, repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain('`dispatch/HO-9152`');
    expect(result.data.text).toContain('git diff HEAD~1 HEAD');
    expect(result.data.text).not.toContain('dispatch/HO-9153');
  });
});

const HO_PATH = 'wiki/handoffs/HO-9152.md';

function hoMarkdown(baseSha: string): string {
  return `---
id: HO-9152
title: Base drift e2e fixture
mode: implement
write_scope: ["src/"]
base_ref: null
base_sha: "${baseSha}"
web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
vars: []
work_item: WK-9152
acceptance:
  - "AC-1: placeholder — never dispatched to a worker"
validation: ["true"]
status: draft
---

## Task
Placeholder. Both tests return before any clone/jail/worker step runs.
`;
}

describe('runDispatch — base drift end to end (WK-0152)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-base-drift-e2e-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9152.md'), WK_BODY);
    // Same model/backend tables as dispatch-v2-e2e.test.ts's setupS3Repo.
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
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
    const stampSha = commitAll(repo, 'init');
    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repo, HO_PATH), hoMarkdown(stampSha));
    // Touches only wiki/handoffs/, which is not a declared path — not drift.
    commitAll(repo, 'add HO');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: the refusal must happen at the real entry point, before anything launches or writes back.
  it('refuses BASE_DRIFT from runDispatch and leaves the HO untouched', async () => {
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    commitAll(repo, 'touch app');
    const before = await readFile(join(repo, HO_PATH), 'utf8');
    const result = await runDispatch({ dir: repo, handoff: HO_PATH, model: 'deepseek', backend: 'openrouter', preflight: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(await readFile(join(repo, HO_PATH), 'utf8')).toBe(before);
  });

  // Why: the fix the message prints must actually work — the orchestrator relies on it (decision 4).
  it('admits after the orchestrator re-stamps base_sha to the printed HEAD', async () => {
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    const newHead = commitAll(repo, 'touch app');
    const refused = await runDispatch({ dir: repo, handoff: HO_PATH, model: 'deepseek', backend: 'openrouter', preflight: false });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain(newHead);

    const content = await readFile(join(repo, HO_PATH), 'utf8');
    await writeFile(join(repo, HO_PATH), content.replace(/^base_sha: .*$/m, `base_sha: "${newHead}"`));

    // effort on a model with no effort mapping is refused by the gate right after
    // admission (the same gate dispatch-v2-e2e.test.ts's EFFORT_UNSUPPORTED test
    // uses), so this proves admission passed without launching a worker.
    const result = await runDispatch({
      dir: repo,
      handoff: HO_PATH,
      model: 'deepseek',
      backend: 'openrouter',
      effort: 'high',
      preflight: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('EFFORT_UNSUPPORTED');
  });
});
