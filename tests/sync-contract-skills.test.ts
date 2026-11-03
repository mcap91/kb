/**
 * WK-0240 stage 2: bootstrap and sync-contract deliver contract/skills/ into
 * .claude/skills/ and .agents/skills/ (templates pattern, byte-identical);
 * sync-contract's warn-only user-global role/skill checks; the CLI and MCP
 * surfaces that carry the new `warnings` field.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bootstrap } from '../packages/wiki-core/src/bootstrap.js';
import { sync } from '../packages/wiki-core/src/sync.js';
import { getSkillSources, getAgentInstructionsSections } from '../packages/wiki-core/src/contract.js';
import { assembleBlockBody } from '../packages/wiki-core/src/agent-instructions.js';
import type { SyncResult } from '../packages/wiki-core/src/types.js';
import { createTmpDir, createBootstrappedRepo, type TmpRepo } from './helpers/tmp-repo.js';

const KB_ROOT = path.resolve(__dirname, '..');
const RESOLVE_SKILL_SRC = path.join(KB_ROOT, 'contract/skills/resolve/SKILL.md');
const TSX = process.platform === 'win32'
  ? path.resolve(KB_ROOT, 'node_modules/.bin/tsx.cmd')
  : path.resolve(KB_ROOT, 'node_modules/.bin/tsx');
const CLI = path.resolve(KB_ROOT, 'packages/wiki-cli/src/index.ts');

const tempHomes: string[] = [];
const tempRepos: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sync-skills-home-'));
  tempHomes.push(dir);
  return dir;
}

function makeTempRepoCopy(src: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sync-skills-repo-'));
  fs.cpSync(src, dir, { recursive: true });
  tempRepos.push(dir);
  return dir;
}

/** Run `fn` with $HOME pointed at `home` — the only way sync()'s warn-only
 *  checks (which read os.homedir()) can be exercised without touching the
 *  real operator home (WK-0240 AC: no test reads the real home). */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** Snapshot every file (by path) under `home`, as bytes — symlinks captured by target. */
function snapshotHome(home: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        files[abs] = `SYMLINK:${fs.readlinkSync(abs)}`;
      } else if (entry.isDirectory()) {
        walk(abs);
      } else {
        files[abs] = fs.readFileSync(abs).toString('base64');
      }
    }
  };
  if (fs.existsSync(home)) walk(home);
  return files;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
  while (tempRepos.length > 0) {
    fs.rmSync(tempRepos.pop()!, { recursive: true, force: true });
  }
});

describe('getSkillSources (contract.ts)', () => {
  it('lists every file under contract/skills/<name>/, recursively, including resolve/SKILL.md', () => {
    const result = getSkillSources();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly one file under resolve/ today (SKILL.md) — confirms the recursive
    // walk returns relPath relative to the skill folder, not an absolute path.
    const resolveFiles = result.data.filter(f => f.skill === 'resolve');
    expect(resolveFiles.map(f => f.relPath)).toEqual(['SKILL.md']);
  });
});

describe('bootstrap: skill delivery', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('writes both runtime copies byte-identical on a fresh repo and lists them in created', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // AC: bootstrap on a fresh repo writes the same two copies, byte-identical, listed in created.
    expect(result.data.created).toContain('.claude/skills/resolve/SKILL.md');
    expect(result.data.created).toContain('.agents/skills/resolve/SKILL.md');

    const srcBytes = fs.readFileSync(RESOLVE_SKILL_SRC);
    expect(fs.readFileSync(path.join(tmp.dir, '.claude/skills/resolve/SKILL.md')).equals(srcBytes)).toBe(true);
    expect(fs.readFileSync(path.join(tmp.dir, '.agents/skills/resolve/SKILL.md')).equals(srcBytes)).toBe(true);
  });

  it('delivers skills with agentInstructions: false and with no wiki/.dispatch/ present (never gated on either)', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo', agentInstructions: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // AC: skill delivery is not gated on wiki/.dispatch/ or the agentInstructions option.
    expect(fs.existsSync(path.join(tmp.dir, 'wiki', '.dispatch'))).toBe(false);
    expect(result.data.created).toContain('.claude/skills/resolve/SKILL.md');
    expect(result.data.created).toContain('.agents/skills/resolve/SKILL.md');
  });
});

describe('sync-contract: skill delivery', () => {
  let tmp: TmpRepo;
  let home: string;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('restores a hand-edited repo copy (listed in synced); an unchanged copy stays listed in skipped; a repo file with no contract counterpart is left in place', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    // Baseline delivery (bootstrap already wrote these; this just establishes the starting state).
    await withHome(home, () => sync({ dir: tmp.dir }));

    const claudeDest = path.join(tmp.dir, '.claude/skills/resolve/SKILL.md');
    fs.writeFileSync(claudeDest, 'HAND EDITED\n', 'utf-8');

    // A repo file with no contract/skills/resolve/ counterpart (templates pattern: overwrite, never delete).
    const strayPath = path.join(tmp.dir, '.claude/skills/resolve/NOTES.md');
    fs.writeFileSync(strayPath, 'operator notes\n', 'utf-8');

    const result = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Restore: the hand edit is overwritten back to the exact contract bytes.
    expect(fs.readFileSync(claudeDest).equals(fs.readFileSync(RESOLVE_SKILL_SRC))).toBe(true);
    expect(result.data.synced).toContain('.claude/skills/resolve/SKILL.md');

    // The untouched Codex copy is reported as skipped (unchanged), not synced.
    expect(result.data.skipped).toContain('.agents/skills/resolve/SKILL.md');

    // A stray file with no source counterpart survives — overwrite, never delete.
    expect(fs.existsSync(strayPath)).toBe(true);
  });

  it('--check lists the skill paths it would write in synced and writes nothing', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    // Remove the skill copies bootstrap already wrote, to isolate what --check would do.
    fs.rmSync(path.join(tmp.dir, '.claude/skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmp.dir, '.agents/skills'), { recursive: true, force: true });

    const result = await withHome(home, () => sync({ dir: tmp.dir, check: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.synced).toContain('.claude/skills/resolve/SKILL.md');
    expect(result.data.synced).toContain('.agents/skills/resolve/SKILL.md');

    // --check must write nothing: the directories stay absent.
    expect(fs.existsSync(path.join(tmp.dir, '.claude/skills'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.dir, '.agents/skills'))).toBe(false);
  });
});

describe('sync-contract: warn-only user-global checks', () => {
  let tmp: TmpRepo;
  let home: string;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('warns with the exact role-drift string when a user-global role copy differs from contract/roles/', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    const stalePath = path.join(home, '.claude', 'commands', 'planner.md');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, 'stale planner text\n', 'utf-8');

    const result = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exact warning string pinned by the AC (backticks around install-roles are literal).
    expect(result.data.warnings).toContain(
      `user-global role ${stalePath} differs from contract/roles/planner.md; run \`install-roles\` from your kb checkout`,
    );
  });

  it('adds no role warning when the user-global copy is byte-for-byte (EOL-normalized) identical', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    const identicalPath = path.join(home, '.codex', 'prompts', 'planner.md');
    fs.mkdirSync(path.dirname(identicalPath), { recursive: true });
    fs.copyFileSync(path.join(KB_ROOT, 'contract/roles/planner.md'), identicalPath);

    const result = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.warnings).toEqual([]);
  });

  it('warns with the exact shadow string for a user-global Claude skill (lstat, so a broken symlink counts) and the exact duplicate string for Codex', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    const claudeSkillPath = path.join(home, '.claude', 'skills', 'resolve');
    fs.mkdirSync(path.dirname(claudeSkillPath), { recursive: true });
    fs.symlinkSync('/nonexistent-target', claudeSkillPath); // broken symlink — lstat still finds it

    const codexSkillPath = path.join(home, '.agents', 'skills', 'resolve');
    fs.mkdirSync(codexSkillPath, { recursive: true });

    const result = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.warnings).toContain(
      `user-global skill ${claudeSkillPath} shadows the repo copy .claude/skills/resolve; remove it`,
    );
    expect(result.data.warnings).toContain(
      `user-global skill ${codexSkillPath} duplicates the repo copy .agents/skills/resolve (Codex shows both in skill selectors); remove it`,
    );
  });

  it('adds no warnings when no user-global role or skill paths exist', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    const result = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.warnings).toEqual([]);
  });

  it('computes warnings in both normal and --check mode, and never writes under $HOME in either (warn only, never installs)', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    const stalePath = path.join(home, '.claude', 'commands', 'planner.md');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, 'stale\n', 'utf-8');
    const claudeSkillPath = path.join(home, '.claude', 'skills', 'resolve');
    fs.mkdirSync(path.dirname(claudeSkillPath), { recursive: true });
    fs.symlinkSync('/nonexistent-target', claudeSkillPath);

    const before = snapshotHome(home);

    const checkResult = await withHome(home, () => sync({ dir: tmp.dir, check: true }));
    expect(checkResult.ok).toBe(true);
    if (checkResult.ok) expect(checkResult.data.warnings.length).toBe(2);
    // --check must not touch $HOME even though it computed warnings.
    expect(snapshotHome(home)).toEqual(before);

    const normalResult = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(normalResult.ok).toBe(true);
    if (normalResult.ok) expect(normalResult.data.warnings.length).toBe(2);
    // Normal mode must not touch $HOME either — warnings never change into installs.
    expect(snapshotHome(home)).toEqual(before);
  });

  it('never changes `ok` or the CLI exit code because of warnings', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();
    const stalePath = path.join(home, '.claude', 'commands', 'planner.md');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, 'stale\n', 'utf-8');

    const result = await withHome(home, () => sync({ dir: tmp.dir }));
    expect(result.ok).toBe(true);

    const { exitCode } = (() => {
      try {
        execSync(`"${TSX}" "${CLI}" sync-contract --dir "${tmp.dir}"`, {
          cwd: KB_ROOT,
          encoding: 'utf-8',
          timeout: 15000,
          env: { ...process.env, HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { exitCode: 0 };
      } catch (err: unknown) {
        return { exitCode: (err as { status?: number }).status ?? 1 };
      }
    })();
    expect(exitCode).toBe(0);
  });
});

describe('cmdSyncContract CLI output', () => {
  let tmp: TmpRepo;
  let home: string;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('prints a "Warnings: <n>" count line and one "  ! warning: <message>" line per warning, after the existing output', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();
    const stalePath = path.join(home, '.claude', 'commands', 'planner.md');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, 'stale\n', 'utf-8');

    const stdout = execSync(`"${TSX}" "${CLI}" sync-contract --dir "${tmp.dir}"`, {
      cwd: KB_ROOT,
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(stdout).toContain('Warnings: 1');
    expect(stdout).toContain(
      `  ! warning: user-global role ${stalePath} differs from contract/roles/planner.md; run \`install-roles\` from your kb checkout`,
    );
  });

  it('prints "Warnings: 0" with no warning lines when there is nothing to report', async () => {
    tmp = await createBootstrappedRepo();
    home = makeTempHome();

    const stdout = execSync(`"${TSX}" "${CLI}" sync-contract --dir "${tmp.dir}"`, {
      cwd: KB_ROOT,
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(stdout).toContain('Warnings: 0');
    expect(stdout).not.toContain('! warning:');
  });
});

describe('wiki-mcp sync-contract tool: warnings pass-through', () => {
  let tmp: TmpRepo;
  let home: string;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('returns warnings in its data with no wiki-mcp code change, because the handler forwards the full sync() Result verbatim (packages/wiki-mcp/src/tools.ts: `handler: async (input) => sync(...)`)', async () => {
    const { tools } = await import('@kb/wiki-mcp');
    const syncTool = tools.find((t: { name: string }) => t.name === 'sync-contract');
    expect(syncTool).toBeTruthy();
    if (!syncTool) return;

    tmp = await createBootstrappedRepo();
    home = makeTempHome();
    const stalePath = path.join(home, '.claude', 'commands', 'planner.md');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, 'stale\n', 'utf-8');

    const result = (await withHome(home, () =>
      syncTool.handler({ dir: tmp.dir }),
    )) as { ok: boolean; data?: SyncResult };

    expect(result.ok).toBe(true);
    expect(result.data?.warnings.length).toBeGreaterThan(0);
  });
});

describe('shipped block text: footer clause (WK-0240 stage 2 fix-up, overseer ruling (ii))', () => {
  it('the emitted block carries the nameless footer clause', () => {
    const sectionsResult = getAgentInstructionsSections();
    expect(sectionsResult.ok).toBe(true);
    if (!sectionsResult.ok) return;

    const emitted = assembleBlockBody(sectionsResult.data, { dispatch: true });
    // Ruling (ii): the clause names no skill, so it stays correct once a second skill ships.
    expect(emitted).toContain(
      'Skills arrive in this repo by `sync-contract`, never user-global.',
    );
  });
});

describe('E2E smoke: sample-repo fixture through bootstrap + sync-contract', () => {
  it('delivers both skill copies byte-identical, restores a hand edit on a second sync, reports exactly the two expected warnings, and leaves HOME unchanged', async () => {
    const fixtureSrc = path.join(KB_ROOT, 'tests/fixtures/sample-repo');
    const repoDir = makeTempRepoCopy(fixtureSrc);
    const home = makeTempHome();

    const stalePlannerPath = path.join(home, '.claude', 'commands', 'planner.md');
    fs.mkdirSync(path.dirname(stalePlannerPath), { recursive: true });
    fs.writeFileSync(stalePlannerPath, 'stale planner text\n', 'utf-8');

    const claudeSkillShadow = path.join(home, '.claude', 'skills', 'resolve');
    fs.mkdirSync(path.dirname(claudeSkillShadow), { recursive: true });
    fs.symlinkSync('/nonexistent-target', claudeSkillShadow);

    // The fixture has no wiki/.wiki-contract.json — bootstrap it first.
    const bootstrapResult = await bootstrap({ dir: repoDir, repo: 'test/sample-repo' });
    expect(bootstrapResult.ok).toBe(true);

    const before = snapshotHome(home);

    const firstSync = await withHome(home, () => sync({ dir: repoDir }));
    expect(firstSync.ok).toBe(true);
    if (!firstSync.ok) return;

    const srcBytes = fs.readFileSync(RESOLVE_SKILL_SRC);
    const claudeDest = path.join(repoDir, '.claude/skills/resolve/SKILL.md');
    const codexDest = path.join(repoDir, '.agents/skills/resolve/SKILL.md');
    expect(fs.readFileSync(claudeDest).equals(srcBytes)).toBe(true);
    expect(fs.readFileSync(codexDest).equals(srcBytes)).toBe(true);

    // Exactly the two expected warnings: one role-drift (planner), one skill-shadow (claude resolve).
    expect(firstSync.data.warnings).toHaveLength(2);
    expect(firstSync.data.warnings).toContain(
      `user-global role ${stalePlannerPath} differs from contract/roles/planner.md; run \`install-roles\` from your kb checkout`,
    );
    expect(firstSync.data.warnings).toContain(
      `user-global skill ${claudeSkillShadow} shadows the repo copy .claude/skills/resolve; remove it`,
    );

    // A hand edit is restored on the next sync.
    fs.writeFileSync(claudeDest, 'HAND EDIT\n', 'utf-8');
    const secondSync = await withHome(home, () => sync({ dir: repoDir }));
    expect(secondSync.ok).toBe(true);
    if (secondSync.ok) {
      expect(fs.readFileSync(claudeDest).equals(srcBytes)).toBe(true);
      expect(secondSync.data.synced).toContain('.claude/skills/resolve/SKILL.md');
    }

    // HOME is never written by sync, across either call.
    expect(snapshotHome(home)).toEqual(before);
  });
});
