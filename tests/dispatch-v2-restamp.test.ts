/**
 * WK-0175 — `restamp`. Proves: restamp updates base_sha (and base_wiki_sha, in
 * nested-private repos) to current HEAD, leaving the rest of the HO file
 * untouched; the restamped HO then admits through checkAdmission; restamp
 * never adds a base_wiki_sha the HO didn't already declare; and the
 * BASE_DRIFT refusal message names the restamp command. Temp dirs only
 * (WK-0043).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { parseHandoff, type Handoff } from '../packages/dispatch-core/src/ho.js';
import { restamp } from '../packages/dispatch-core/src/restamp.js';

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

const WK_BODY = '---\nid: "WK-9175"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9175\n---\n\n# WK-9175: Fixture\n';
const HO_PATH = 'wiki/handoffs/HO-9175.md';

function hoMarkdown(overrides: { baseSha: string; baseWikiSha?: string }): string {
  const wikiLine = overrides.baseWikiSha ? `base_wiki_sha: "${overrides.baseWikiSha}"\n` : '';
  return `---
id: HO-9175
title: Restamp fixture
mode: implement
write_scope: ["src/"]
base_ref: null
base_sha: "${overrides.baseSha}"
${wikiLine}web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
vars: []
work_item: WK-9175
acceptance:
  - "AC-1: placeholder"
validation: ["true"]
status: draft
---

## Task
Placeholder body — restamp must not touch this.
`;
}

describe('restamp (WK-0175) — tracked wiki (the normal repo shape)', () => {
  let repo: string;
  let stampSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-restamp-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9175.md'), WK_BODY);
    stampSha = commitAll(repo, 'init');
    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repo, HO_PATH), hoMarkdown({ baseSha: stampSha }));
    commitAll(repo, 'add HO');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: restamp is the mechanized fix for a stale stamp — it must actually land the new HEAD.
  it('updates base_sha to current HEAD and admits afterward', async () => {
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    const newHead = commitAll(repo, 'touch app');

    const before = await checkAdmission(
      { id: 'HO-9175', title: 'x', mode: 'implement', write_scope: ['src/'], base_ref: null, base_sha: stampSha, web: false, credentials: [], data_mounts: [], export_mounts: [], read_first: ['README.md'], vars: [], work_item: 'WK-9175', acceptance: ['a'], validation: ['true'], status: 'draft' } as Handoff,
      repo,
    );
    expect(before.ok).toBe(false);

    const result = await restamp({ dir: repo, handoff: HO_PATH });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.handoffId).toBe('HO-9175');
    expect(result.data.base_sha).toBe(newHead);
    expect(result.data.base_wiki_sha).toBeUndefined();

    const parsed = await parseHandoff(join(repo, HO_PATH));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.base_sha).toBe(newHead);

    const admitted = await checkAdmission(parsed.data, repo);
    expect(admitted.ok).toBe(true);
  });

  // Why: restamp must not disturb anything but the stamp fields (body, other frontmatter).
  it('leaves the rest of the HO file untouched', async () => {
    const before = await readFile(join(repo, HO_PATH), 'utf8');
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 2;\n');
    commitAll(repo, 'touch app');

    const result = await restamp({ dir: repo, handoff: HO_PATH });
    expect(result.ok).toBe(true);

    const after = await readFile(join(repo, HO_PATH), 'utf8');
    expect(after).toContain('## Task');
    expect(after).toContain('Placeholder body — restamp must not touch this.');
    expect(after).toContain('title: Restamp fixture');
    // Only the base_sha line should differ.
    const diffLines = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
    expect(diffLines.every((line) => line.startsWith('base_sha:'))).toBe(true);
  });

  // Why: restamp never invents a base_wiki_sha the HO didn't already declare (tracked repos have none).
  it('does not add base_wiki_sha when the HO never declared one', async () => {
    const result = await restamp({ dir: repo, handoff: HO_PATH });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.base_wiki_sha).toBeUndefined();

    const content = await readFile(join(repo, HO_PATH), 'utf8');
    expect(content).not.toContain('base_wiki_sha');
  });

  // Why: a bad handoff path must fail loud, not silently no-op.
  it('fails with FILE_NOT_FOUND for a missing handoff', async () => {
    const result = await restamp({ dir: repo, handoff: 'wiki/handoffs/HO-0000.md' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('FILE_NOT_FOUND');
  });
});

describe('restamp (WK-0175) — nested-private wiki (wiki/ is its own repo)', () => {
  let repo: string;
  let wikiDir: string;
  let stampSha: string;
  let wikiSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-restamp-nested-'));
    initRepo(repo);
    await writeFile(join(repo, '.gitignore'), 'wiki/\n');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    wikiDir = join(repo, 'wiki');
    await mkdir(join(wikiDir, 'issues'), { recursive: true });
    await writeFile(join(wikiDir, 'issues', 'WK-9175.md'), WK_BODY);
    stampSha = commitAll(repo, 'init');
    initRepo(wikiDir);
    wikiSha = commitAll(wikiDir, 'wiki init');

    await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repo, HO_PATH), hoMarkdown({ baseSha: stampSha, baseWikiSha: wikiSha }));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: nested-private HOs carry two stamps — both must move to their respective HEADs.
  it('updates both base_sha and base_wiki_sha to current HEAD', async () => {
    await writeFile(join(wikiDir, 'issues', 'WK-9175.md'), 'changed\n');
    const newWikiHead = commitAll(wikiDir, 'touch ticket');

    const result = await restamp({ dir: repo, handoff: HO_PATH });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.base_sha).toBe(stampSha);
    expect(result.data.base_wiki_sha).toBe(newWikiHead);

    const parsed = await parseHandoff(join(repo, HO_PATH));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.base_wiki_sha).toBe(newWikiHead);

    const admitted = await checkAdmission(parsed.data, repo);
    expect(admitted.ok).toBe(true);
  });
});

describe('BASE_DRIFT refusal message names restamp (WK-0175)', () => {
  let repo: string;
  let stampSha: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-restamp-message-'));
    initRepo(repo);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const v = 1;\n');
    await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
    await writeFile(join(repo, 'wiki', 'issues', 'WK-9175.md'), WK_BODY);
    stampSha = commitAll(repo, 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('names the restamp command as the remediation', async () => {
    const handoff: Handoff = {
      id: 'HO-9175',
      title: 'x',
      mode: 'implement',
      write_scope: ['src/'],
      base_ref: null,
      web: false,
      credentials: [],
      data_mounts: [],
      export_mounts: [],
      read_first: ['README.md'],
      vars: [],
      work_item: 'WK-9175',
      acceptance: ['a'],
      validation: ['true'],
      status: 'draft',
    };
    const result = await checkAdmission(handoff, repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BASE_DRIFT');
    expect(result.message).toContain('npm run dispatch -- restamp');
    expect(result.message).toContain('MCP restamp tool');
    void stampSha;
  });
});
