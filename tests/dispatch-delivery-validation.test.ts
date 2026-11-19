/**
 * Host validation at delivery: a real runDispatch() with only `spawnIsolated`
 * mocked (worker and validation steps alike). The worker mock writes a file
 * into the clone so the run really delivers; the validation mock answers for
 * the registered command. Proves the pipeline runs the suite once per
 * implement delivery, that a red or impossible validation never changes the
 * delivered outcome, and that the response doc and run result carry the
 * outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runDispatch } from '../packages/dispatch-core/src/pipeline.js';
import * as spawnIsolatedModule from '../packages/dispatch-core/src/spawn-isolated.js';
import { VALIDATION_EVIDENCE_FILE } from '../packages/dispatch-core/src/host-validation.js';
import { slicesSection } from './helpers/slice-fixture.js';
import { stubToolchainProbes } from './helpers/toolchain-stub.js';

const SUITE_COMMAND = 'check-suite';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

/** A committed temp repo: one HO of the given mode, claude backend tables, and an optional validation registry. */
async function setupRepo(opts: { mode: 'implement' | 'code_review'; registry?: string | null }): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'kb-delivery-validation-'));
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  const writeScope = opts.mode === 'implement' ? ['src/'] : [];
  const ho = `---
id: HO-V0001
title: Delivery validation fixture
mode: ${opts.mode}
write_scope: ${JSON.stringify(writeScope)}
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
vars: []
work_item: WK-9005
slice: s1
acceptance:
  - "AC-1: placeholder"
validation: ["node --test test/"]
status: draft
---

## Task
Fixture body.
`;
  await mkdir(join(repo, 'wiki', 'handoffs'), { recursive: true });
  await writeFile(join(repo, 'wiki', 'handoffs', 'HO-V0001.md'), ho, 'utf8');
  await writeFile(join(repo, 'README.md'), 'fixture\n', 'utf8');
  await mkdir(join(repo, 'wiki', 'issues'), { recursive: true });
  await writeFile(
    join(repo, 'wiki', 'issues', 'WK-9005.md'),
    `---\nid: "WK-9005"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9005\n---\n\n# WK-9005: Fixture\n\n${slicesSection()}`,
    'utf8',
  );
  await mkdir(join(repo, 'wiki', 'initiatives'), { recursive: true });
  await writeFile(
    join(repo, 'wiki', 'initiatives', 'IN-9005.md'),
    '---\nid: "IN-9005"\ntitle: "Fixture initiative"\nstatus: todo\n---\n\n# IN-9005: Fixture\n',
    'utf8',
  );
  const dispatchDir = join(repo, 'wiki', '.dispatch');
  await mkdir(dispatchDir, { recursive: true });
  await writeFile(
    join(dispatchDir, 'models.json'),
    JSON.stringify({ 'claude-sonnet-5': { available_on: ['claude-saas'], model_id: 'claude-sonnet-5' } }),
    'utf8',
  );
  await writeFile(
    join(dispatchDir, 'backends.json'),
    JSON.stringify({ 'claude-saas': { family: 'claude', base_url: null, api_key_env: null, secrets_file: null } }),
    'utf8',
  );
  await writeFile(join(dispatchDir, 'profiles.json'), JSON.stringify({ schema_version: 1 }), 'utf8');
  if (opts.registry !== undefined && opts.registry !== null) {
    await writeFile(join(dispatchDir, 'validation.json'), opts.registry, 'utf8');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial commit');
  const head = git(repo, 'rev-parse', 'HEAD');
  const hoPath = join(repo, 'wiki', 'handoffs', 'HO-V0001.md');
  await writeFile(hoPath, (await readFile(hoPath, 'utf8')).replace('base_ref: null\n', `base_ref: null\nbase_sha: "${head}"\n`), 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'stamp');
  return repo;
}

const REGISTRY = JSON.stringify({ schema_version: 1, commands: [{ name: 'unit', argv: [SUITE_COMMAND], timeout_ms: 30_000 }] });

/**
 * Mock spawnIsolated. The worker call (it has a stdout log path) writes
 * `src/feature.ts` into the clone, so delivery lands a commit; a call whose
 * command is the registered suite gets `suite`'s answer.
 */
function mockSpawns(suite: 'pass' | 'fail' | 'fail_then_pass' | 'spawn_error'): { suiteCalls: () => number } {
  let suiteCalls = 0;
  const fixture = readFileSync(join(__dirname, 'fixtures', 'claude-p-output.txt'), 'utf8');
  vi.spyOn(spawnIsolatedModule, 'spawnIsolated').mockImplementation(async (plan, opts) => {
    const base = { stdout: '', stderr: '', signal: null, truncated: false, timedOut: false, streamDrainTimedOut: false };
    if (plan.command[0] === SUITE_COMMAND) {
      suiteCalls += 1;
      if (suite === 'spawn_error') return { ok: false, error: 'PIPELINE_FAILED', message: 'bwrap could not start' } as never;
      return { ok: true, data: { ...base, exitCode: suite === 'pass' || (suite === 'fail_then_pass' && suiteCalls > 1) ? 0 : 1 } };
    }
    if (opts?.stdoutLogPath) {
      await writeFile(opts.stdoutLogPath, fixture, 'utf8');
      const clone = plan.bwrapArgs.find((a) => /\.kb-dispatch\/clones\/[^/]+$/.test(a));
      if (clone !== undefined) {
        await mkdir(join(clone, 'src'), { recursive: true });
        await writeFile(join(clone, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf8');
      }
    }
    return { ok: true, data: { ...base, exitCode: 0 } };
  });
  return { suiteCalls: () => suiteCalls };
}

async function dispatchFixture(repo: string) {
  return runDispatch({
    dir: repo,
    handoff: 'wiki/handoffs/HO-V0001.md',
    model: 'claude-sonnet-5',
    backend: 'claude-saas',
    preflight: false,
  });
}

async function evidenceFile(result: { runDir: string }): Promise<string> {
  return join(result.runDir, VALIDATION_EVIDENCE_FILE);
}

describe('host validation at delivery (mocked spawnIsolated)', () => {
  const repos: string[] = [];
  // A claude dispatch reads ~/.claude/.credentials.json once at launch; the
  // suite must run on a host that has none, so plant one in a throwaway HOME.
  let savedHome: string | undefined;
  let testHome: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    testHome = await mkdtemp(join(tmpdir(), 'kb-delivery-home-'));
    await mkdir(join(testHome, '.claude'), { recursive: true });
    await writeFile(
      join(testHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'planted-claude-access-0123456789' } }),
      'utf8',
    );
    process.env.HOME = testHome;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const r of repos.splice(0)) await rm(r, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (testHome) await rm(testHome, { recursive: true, force: true });
    testHome = undefined;
  });

  it('writes passing evidence into the run dir and shows one pass line in the response doc', async () => {
    const repo = await setupRepo({ mode: 'implement', registry: REGISTRY });
    repos.push(repo);
    const spawns = mockSpawns('pass');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.delivery.status).toBe('delivered');
    expect(spawns.suiteCalls()).toBe(1);
    const evidence = JSON.parse(await readFile(await evidenceFile(result.data), 'utf8'));
    expect(evidence).toMatchObject({
      handoff_id: 'HO-V0001',
      run_id: result.data.runId,
      delivery_branch: 'dispatch/HO-V0001',
      outcome: 'pass',
    });
    expect(evidence.delivery_sha).toBe(git(repo, 'rev-parse', 'dispatch/HO-V0001'));
    expect(result.data.hostValidation).toEqual({ status: 'pass', commandCount: 1 });
    expect(await readFile(result.data.responsePath, 'utf8')).toContain('\nHost validation: pass.\n');
  });

  it('a red suite leaves the run delivered, records the failure and the base-commit result, and names the failed command', async () => {
    const repo = await setupRepo({ mode: 'implement', registry: REGISTRY });
    repos.push(repo);
    const spawns = mockSpawns('fail');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.delivery.status).toBe('delivered');
    // One run on the delivery, one on the base commit.
    expect(spawns.suiteCalls()).toBe(2);
    expect(result.data.hostValidation).toEqual({
      status: 'fail',
      failedCommands: ['unit'],
      baseline: { status: 'ran', alsoFailing: ['unit'] },
    });
    const evidence = JSON.parse(await readFile(await evidenceFile(result.data), 'utf8'));
    expect(evidence.outcome).toBe('fail');
    expect(evidence.baseline.status).toBe('ran');
    const doc = await readFile(result.data.responsePath, 'utf8');
    expect(doc).toContain('outcome: delivered');
    expect(doc).toContain('\nHost validation: fail (unit). Also failing on the base commit: unit.\n');
  });

  it('a red suite that passes on the base commit says the base passes the same commands, not "none"', async () => {
    const repo = await setupRepo({ mode: 'implement', registry: REGISTRY });
    repos.push(repo);
    mockSpawns('fail_then_pass');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hostValidation).toEqual({ status: 'fail', failedCommands: ['unit'], baseline: { status: 'ran', alsoFailing: [] } });
    const doc = await readFile(result.data.responsePath, 'utf8');
    expect(doc).toContain('\nHost validation: fail (unit). The base commit passes the same commands, so this delivery introduced the failure.\n');
    expect(doc).not.toContain('Also failing on the base commit');
  });

  it('a jail failure leaves the run delivered, writes no evidence, and records why', async () => {
    const repo = await setupRepo({ mode: 'implement', registry: REGISTRY });
    repos.push(repo);
    mockSpawns('spawn_error');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.delivery.status).toBe('delivered');
    expect(result.data.hostValidation).toMatchObject({ status: 'not_run', reason: expect.stringContaining('bwrap could not start') });
    await expect(stat(await evidenceFile(result.data))).rejects.toThrow();
    expect(await readFile(result.data.responsePath, 'utf8')).toContain('\nHost validation: not run (bwrap could not start');
  });

  it('an unreadable registry leaves the run delivered and records the cause', async () => {
    const repo = await setupRepo({ mode: 'implement', registry: '{ not json' });
    repos.push(repo);
    const spawns = mockSpawns('pass');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.delivery.status).toBe('delivered');
    expect(spawns.suiteCalls()).toBe(0);
    expect(result.data.hostValidation?.status).toBe('not_run');
    expect(await readFile(result.data.responsePath, 'utf8')).toMatch(/\nHost validation: not run \(.+\)\.\n/);
  });

  it('a repo with no registry records passing evidence and says no commands were registered', async () => {
    const repo = await setupRepo({ mode: 'implement' });
    repos.push(repo);
    const spawns = mockSpawns('pass');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spawns.suiteCalls()).toBe(0);
    expect(result.data.hostValidation).toEqual({ status: 'pass', commandCount: 0 });
    expect(JSON.parse(await readFile(await evidenceFile(result.data), 'utf8'))).toMatchObject({ outcome: 'pass', commands: [] });
    expect(await readFile(result.data.responsePath, 'utf8')).toContain('Host validation: pass (no commands registered).');
  });

  it('does not validate a code_review run', async () => {
    const repo = await setupRepo({ mode: 'code_review', registry: REGISTRY });
    repos.push(repo);
    const spawns = mockSpawns('pass');
    stubToolchainProbes({ name: 'claude', path: '/usr/bin/claude' });
    const result = await dispatchFixture(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spawns.suiteCalls()).toBe(0);
    expect(result.data.hostValidation).toBeUndefined();
    await expect(stat(await evidenceFile(result.data))).rejects.toThrow();
    expect(await readFile(result.data.responsePath, 'utf8')).not.toContain('Host validation');
    expect(dirname(result.data.responsePath)).toBe(result.data.runDir);
  });
});
