/**
 * The tunnel forwarder is the one process dispatch spawns outside bwrap, and
 * the run must not proceed to the jailed worker when it cannot start. This
 * file proves that fail-closed branch directly, by faking ONLY the forwarder
 * spawn (`node:child_process`) and keeping the real module for every other
 * call (`execFile`/`execFileSync` and the non-forwarder `spawn` legs all
 * delegate to `importOriginal`).
 *
 * The real bwrap probe still runs, so this is a WSL2/Linux test; the jailed
 * worker itself is mocked because it is never supposed to be reached.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childControl = vi.hoisted(() => ({ behavior: 'error' as 'error' | 'exited' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (...spawnArgs: unknown[]) => {
    const argv = spawnArgs[1];
    if (Array.isArray(argv) && typeof argv[0] === 'string' && argv[0].endsWith('forwarder.cjs')) {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      child.pid = 424242;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
        return true;
      };
      if (childControl.behavior === 'exited') {
        child.exitCode = 1;
      } else {
        process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
      }
      return child as unknown as ChildProcess;
    }
    return (actual.spawn as (...args: unknown[]) => unknown)(...spawnArgs);
  };
  return { ...actual, spawn };
});

import { runDispatch } from '../packages/dispatch-core/src/pipeline.js';
import * as spawnIsolatedModule from '../packages/dispatch-core/src/spawn-isolated.js';
import { slicesSection } from './helpers/slice-fixture.js';
import { stubToolchainProbes } from './helpers/toolchain-stub.js';

/**
 * A minimal, known-good pi fixture -- the same shapes `dispatch-v2-e2e` /
 * `dispatch-v2-tunnel-integration` use so the run reaches the forwarder spawn
 * without an unrelated refusal gate tripping first. No credentials, no
 * lockfile, `web:false`.
 */
async function setupRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'kb-fwdstart-'));
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });

  const hoContent = `---
id: HO-FWDSTART
title: Forwarder start-failure fixture
mode: implement
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
vars: []
work_item: WK-9161
slice: s1
acceptance:
  - "AC-1: placeholder -- the worker is never reached"
validation: ["true"]
status: draft
---

## Task
Placeholder fixture. The forwarder fail-closed branch returns before any
worker invocation, so this body is never read by a real worker.
`;
  await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
  await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-FWDSTART.md'), hoContent, 'utf8');
  await writeFile(join(repoRoot, 'README.md'), 'kb-fwdstart-fixture\n', 'utf8');

  await mkdir(join(repoRoot, 'wiki', 'issues'), { recursive: true });
  await writeFile(
    join(repoRoot, 'wiki', 'issues', 'WK-9161.md'),
    `---\nid: "WK-9161"\ntitle: "Fixture WK"\nstatus: todo\ninitiative: IN-9161\n---\n\n# WK-9161: Fixture\n\n${slicesSection()}`,
    'utf8',
  );
  await mkdir(join(repoRoot, 'wiki', 'initiatives'), { recursive: true });
  await writeFile(
    join(repoRoot, 'wiki', 'initiatives', 'IN-9161.md'),
    '---\nid: "IN-9161"\ntitle: "Fixture initiative"\nstatus: todo\n---\n\n# IN-9161: Fixture\n',
    'utf8',
  );

  await mkdir(join(repoRoot, 'wiki', '.dispatch'), { recursive: true });
  const models = { deepseek: { available_on: ['openrouter'], model_id: 'deepseek/deepseek-v4-flash-0731' } };
  const backends = {
    openrouter: { family: 'pi', base_url: 'https://openrouter.ai/api/v1', api_key_env: null, secrets_file: null },
  };
  const profiles = { schema_version: 1 };
  await writeFile(join(repoRoot, 'wiki', '.dispatch', 'models.json'), JSON.stringify(models, null, 2), 'utf8');
  await writeFile(join(repoRoot, 'wiki', '.dispatch', 'backends.json'), JSON.stringify(backends, null, 2), 'utf8');
  await writeFile(join(repoRoot, 'wiki', '.dispatch', 'profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');

  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
  const hoPath = join(repoRoot, 'wiki', 'handoffs', 'HO-FWDSTART.md');
  const stamped = (await readFile(hoPath, 'utf8')).replace('base_ref: null\n', `base_ref: null\nbase_sha: "${head}"\n`);
  await writeFile(hoPath, stamped, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'stamp'], { cwd: repoRoot });

  return repoRoot;
}

describe('forwarder start failure stops the run before the worker spawns', () => {
  let repoRoot: string | undefined;

  beforeEach(() => {
    stubToolchainProbes({ name: 'pi', path: '/usr/bin/pi' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  async function runWithForwarderBehavior(behavior: 'error' | 'exited') {
    childControl.behavior = behavior;
    repoRoot = await setupRepo();
    const spawnIsolatedSpy = vi.spyOn(spawnIsolatedModule, 'spawnIsolated').mockImplementation(async () => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false, streamDrainTimedOut: false },
    }));
    const result = await runDispatch({
      dir: repoRoot,
      handoff: 'wiki/handoffs/HO-FWDSTART.md',
      model: 'deepseek',
      backend: 'openrouter',
      preflight: false,
    });
    return { result, spawnIsolatedSpy };
  }

  it('returns PIPELINE_FAILED when the forwarder child emits an error', async () => {
    const { result, spawnIsolatedSpy } = await runWithForwarderBehavior('error');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('PIPELINE_FAILED');
    expect(result.message).toContain('Tunnel forwarder failed to start');
    expect(result.message).toContain('spawn ENOENT');
    expect(spawnIsolatedSpy).not.toHaveBeenCalled();
  }, 20_000);

  it('returns PIPELINE_FAILED when the forwarder child has already exited', async () => {
    const { result, spawnIsolatedSpy } = await runWithForwarderBehavior('exited');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('PIPELINE_FAILED');
    expect(result.message).toContain('Tunnel forwarder failed to start');
    expect(result.message).toContain('exit code 1');
    expect(spawnIsolatedSpy).not.toHaveBeenCalled();
  }, 20_000);
});
