/**
 * WK-0294 — host-run validation (host-validation.ts) against a REAL bwrap
 * jail and a REAL delivery clone. Proves the DEC-0047 A2 R5 / A4 confinement
 * claims with planted violations: a delivery script that tries the network,
 * reads a host path outside the clone, and prints a secret in a name the
 * deny-list does not recognize gets none of the three, while its own result
 * is captured; only setup has network and npm lifecycle scripts stay off; a
 * timed-out command's surviving descendant is reaped; evidence lands in the
 * implement run dir keyed to the delivery sha, run id, and registry
 * fingerprint. Temp dirs only (WK-0043); skips loudly without a working bwrap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '@kb/wiki-core';

import { createHandoff } from '../packages/dispatch-core/src/create-handoff.js';
import { SLICE_ID, writeSliceWorkItem } from './helpers/slice-fixture.js';
import { deriveReview } from '../packages/dispatch-core/src/derive-review.js';
import { mergeDelivery } from '../packages/dispatch-core/src/merge-delivery.js';
import {
  JAIL_HERMETICITY_TEACHING_SENTENCE,
  VALIDATION_EVIDENCE_FILE,
  evidenceForDelivery,
  readValidationEvidence,
  renderValidationEvidence,
  runHostValidation,
  summarizeValidation,
  validationGateRefusal,
  type ValidationEvidence,
  type ValidationStepResult,
} from '../packages/dispatch-core/src/host-validation.js';
import * as spawnIsolatedModule from '../packages/dispatch-core/src/spawn-isolated.js';
import {
  loadValidationRegistry,
  validationRegistryFingerprint,
  type ValidationRegistry,
} from '../packages/dispatch-core/src/repo-config.js';

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
  console.warn('SKIPPED: "host validation (WK-0294)" requires a working bwrap (`bwrap --ro-bind / / true` failed).');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

const HANDOFF_ID = 'HO-9294';
const RUN_ID = 'RUN-00000000-0000-4000-8000-000000000001';

function registry(overrides: Partial<ValidationRegistry> = {}): ValidationRegistry {
  return { setup: null, commands: [], env: {}, runtime_paths: [], ...overrides };
}

describe.skipIf(!BWRAP_FUNCTIONAL)('runHostValidation (WK-0294) — real bwrap', () => {
  let repo: string;
  let outside: string;
  let deliverySha: string;
  let server: Server;
  let port: number;
  let connections: number;

  /** Commit `files` on dispatch/HO-9294 off the current HEAD; returns the delivery sha. */
  async function deliver(files: Record<string, string>): Promise<string> {
    const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(repo, 'checkout', '-q', '-b', `dispatch/${HANDOFF_ID}`);
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'delivery');
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', base);
    return sha;
  }

  function run(reg: ValidationRegistry | null) {
    return runHostValidation({
      dir: repo,
      handoffId: HANDOFF_ID,
      runId: RUN_ID,
      deliveryBranch: `dispatch/${HANDOFF_ID}`,
      deliverySha,
      registry: reg,
    });
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-host-validation-'));
    outside = await mkdtemp(join(tmpdir(), 'kb-host-validation-outside-'));
    await writeFile(join(outside, 'host-secret.txt'), 'host-only content\n');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    connections = 0;
    server = createServer((socket) => {
      connections += 1;
      // WK-0316: the bash /dev/tcp probe (and this file's own reset test below) can close or
      // reset the connection before reading `hello\n`. The kernel then sends RST, and Node
      // surfaces that as ECONNRESET here — an expected early close, not a production fault.
      // Any other code is unexpected and must still fail the run (AGENTS.md rule 24).
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET') return;
        throw err;
      });
      socket.end('hello\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  // Why: A4.3 + A2 R5 — the three escape routes a malicious delivery would try must all be closed,
  // while the command's own result is still recorded.
  it('denies network, host paths outside the clone, and unrecognized-name secrets to a registered command', async () => {
    process.env.DATABASE_URL = 'postgres://user:hunter2@db.internal/prod';
    const probe = [
      `if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then echo net=open; else echo net=denied; fi`,
      `if [ -e "${join(outside, 'host-secret.txt')}" ]; then echo file=visible; else echo file=absent; fi`,
      'echo "db=${DATABASE_URL:-}"',
      'echo "declared=${DECLARED:-}"',
      'echo "home=$HOME tmpdir=$TMPDIR"',
      'exit 3',
    ].join('\n');
    deliverySha = await deliver({ 'probe.sh': `${probe}\n` });

    const result = await run(
      registry({ env: { DECLARED: 'from-registry' }, commands: [{ name: 'probe', argv: ['bash', 'probe.sh'], timeout_ms: 30_000 }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [probeResult] = result.data.commands;
    expect(probeResult).toMatchObject({ name: 'probe', exit_code: 3, result: 'fail', network: false });
    const out = probeResult?.stdout_tail ?? '';
    expect(out).toContain('net=denied');
    expect(out).toContain('file=absent');
    expect(out).toContain('db=\n');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('declared=from-registry');
    expect(out).toContain('home=/tmp tmpdir=/tmp');
    expect(connections).toBe(0);
    expect(result.data.outcome).toBe('fail');
  });

  // Why: A4.2 — setup is the only networked step, and npm lifecycle scripts from the delivery never run.
  it('gives network to setup only and forces npm lifecycle scripts off', async () => {
    const pkg = { name: 'fixture', version: '1.0.0', scripts: { preinstall: 'touch preinstall-ran' } };
    const lock = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } };
    const netProbe = `if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then echo net=open; else echo net=denied; fi\n`;
    deliverySha = await deliver({
      'package.json': JSON.stringify(pkg),
      'package-lock.json': JSON.stringify(lock),
      'net.sh': netProbe,
      'check.sh': 'bash net.sh\nif [ -e preinstall-ran ]; then echo preinstall=ran; else echo preinstall=skipped; fi\n',
    });

    const result = await run(
      registry({
        setup: { argv: ['bash', '-c', 'bash net.sh && npm ci --no-audit --no-fund'], timeout_ms: 120_000 },
        commands: [{ name: 'check', argv: ['bash', 'check.sh'], timeout_ms: 30_000 }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.setup).toMatchObject({ name: 'setup', network: true, result: 'pass' });
    expect(result.data.setup?.stdout_tail).toContain('net=open');
    const check = result.data.commands[0]?.stdout_tail ?? '';
    expect(check).toContain('net=denied');
    expect(check).toContain('preinstall=skipped');
    expect(result.data.outcome).toBe('pass');
  });

  // Why: A4.6 — a timeout must reap the whole jail, including a descendant that ignores SIGTERM in its own session.
  it('kills the process group on timeout and leaves no surviving descendant', async () => {
    const marker = `kb-planted-${randomUUID()}`;
    deliverySha = await deliver({
      'hang.sh': `setsid bash -c 'trap "" TERM; while :; do sleep 0.1; done' ${marker} &\ntrap "" TERM\nwhile :; do sleep 0.1; done\n`,
    });
    const result = await run(registry({ commands: [{ name: 'hang', argv: ['bash', 'hang.sh'], timeout_ms: 1_000 }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.commands[0]).toMatchObject({ timed_out: true, result: 'fail' });
    let survivors = '';
    try {
      survivors = execFileSync('pgrep', ['-f', marker]).toString().trim();
    } catch {
      survivors = '';
    }
    expect(survivors).toBe('');
  }, 30_000);

  // Why: A4.1 + A2 R2 — evidence is the host original in the implement run dir, keyed to sha, run id, fingerprint.
  it('writes the evidence JSON into the implement run dir, keyed to the delivery', async () => {
    deliverySha = await deliver({ 'ok.sh': 'echo all good\n' });
    const reg = registry({ commands: [{ name: 'ok', argv: ['bash', 'ok.sh'], timeout_ms: 30_000 }] });
    const result = await run(reg);
    expect(result.ok).toBe(true);
    const path = join(repo, '.agent-runs', 'runs', HANDOFF_ID, RUN_ID, VALIDATION_EVIDENCE_FILE);
    const read = await readValidationEvidence(path);
    expect(read.ok).toBe(true);
    if (!read.ok || read.data === null) return;
    expect(read.data).toMatchObject({
      handoff_id: HANDOFF_ID,
      run_id: RUN_ID,
      delivery_sha: deliverySha,
      delivery_branch: `dispatch/${HANDOFF_ID}`,
      registry_fingerprint: validationRegistryFingerprint(reg),
      outcome: 'pass',
    });
    expect(read.data.commands[0]?.stdout_tail).toBe('all good\n');
    expect(renderValidationEvidence(read.data)).toContain('all good');
  });

  // Why: D2 ruling 2 item 5 — a committed .env never reaches the validation jail either.
  it('masks a committed .env in the validation clone', async () => {
    deliverySha = await deliver({ '.env': 'API_TOKEN=leaked\n', 'env.sh': 'cat .env; echo "[end]"\n' });
    const result = await run(registry({ commands: [{ name: 'env', argv: ['bash', 'env.sh'], timeout_ms: 30_000 }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.commands[0]?.stdout_tail).toBe('[end]\n');
  });

  // Why: a validation run clones the delivery too
  // (`runHostValidation` -> `createClone`, no admission pass); a tracked
  // mask-path symlink in the delivered tree must refuse there as well,
  // writing no evidence (the merge gate must see evidence as missing, not
  // a misleadingly-empty pass).
  it('refuses a delivery whose .claude is a tracked symlink, writing no evidence', async () => {
    const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(repo, 'checkout', '-q', '-b', `dispatch/${HANDOFF_ID}`);
    await symlink('.git', join(repo, '.claude'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'symlinked delivery');
    deliverySha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', base);

    const result = await run(registry({ commands: [{ name: 'should-not-run', argv: ['bash', '-c', 'echo should-not-run'], timeout_ms: 5_000 }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('.claude');

    const evidencePath = join(repo, '.agent-runs', 'runs', HANDOFF_ID, RUN_ID, VALIDATION_EVIDENCE_FILE);
    const read = await readValidationEvidence(evidencePath);
    expect(read).toEqual({ ok: true, data: null });
  });

  // Why: one suite run per (delivery sha, registry) pair — the delivery step and derive-review share this function.
  describe('evidenceForDelivery', () => {
    const reg = () => registry({ commands: [{ name: 'ok', argv: ['bash', 'ok.sh'], timeout_ms: 30_000 }] });
    const opts = (sha: string, r: ValidationRegistry | null) => ({
      dir: repo,
      handoffId: HANDOFF_ID,
      runId: RUN_ID,
      deliveryBranch: `dispatch/${HANDOFF_ID}`,
      deliverySha: sha,
      registry: r,
    });

    it('reuses evidence for the same sha and registry fingerprint without running the suite again', async () => {
      deliverySha = await deliver({ 'ok.sh': 'echo hi\n' });
      const first = await evidenceForDelivery(opts(deliverySha, reg()));
      const second = await evidenceForDelivery(opts(deliverySha, reg()));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data.started_at).toBe(first.data.started_at);
      expect(second.data).toEqual(first.data);
    });

    it('runs again when the registry fingerprint changed', async () => {
      deliverySha = await deliver({ 'ok.sh': 'echo hi\n' });
      const first = await evidenceForDelivery(opts(deliverySha, reg()));
      const changed = registry({ commands: [{ name: 'ok', argv: ['bash', 'ok.sh', 'again'], timeout_ms: 30_000 }] });
      const second = await evidenceForDelivery(opts(deliverySha, changed));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data.started_at).not.toBe(first.data.started_at);
      expect(second.data.registry_fingerprint).toBe(validationRegistryFingerprint(changed));
    });

    it('runs again when the delivery sha differs', async () => {
      deliverySha = await deliver({ 'ok.sh': 'echo hi\n' });
      const first = await evidenceForDelivery(opts(deliverySha, reg()));
      git(repo, 'checkout', '-q', `dispatch/${HANDOFF_ID}`);
      await writeFile(join(repo, 'more.txt'), 'more\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'second delivery commit');
      const newSha = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'checkout', '-q', '-');
      const second = await evidenceForDelivery(opts(newSha, reg()));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data.delivery_sha).toBe(newSha);
      expect(second.data.started_at).not.toBe(first.data.started_at);
    });

    // Why: the host can always produce the evidence again, so a damaged file must not block the gate for ever.
    it.each([
      ['not JSON', '{ not json'],
      ['JSON of the wrong shape', '{"schema_version": 2}'],
    ])('treats an evidence file that is %s as stale: runs again and rewrites it', async (_name, damaged) => {
      deliverySha = await deliver({ 'ok.sh': 'echo hi\n' });
      const path = join(repo, '.agent-runs', 'runs', HANDOFF_ID, RUN_ID, VALIDATION_EVIDENCE_FILE);
      await mkdir(join(repo, '.agent-runs', 'runs', HANDOFF_ID, RUN_ID), { recursive: true });
      await writeFile(path, damaged);
      const result = await evidenceForDelivery(opts(deliverySha, reg()));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toMatchObject({ delivery_sha: deliverySha, outcome: 'pass' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(result.data);
    });
  });

  // Why: a stored green is reused (no second run) but a stored red is re-checked, so a flaky failure
  // never sticks to a delivery and a green never costs a second run.
  describe('stored evidence reuse by outcome', () => {
    const opts = (r: ValidationRegistry) => ({
      dir: repo,
      handoffId: HANDOFF_ID,
      runId: RUN_ID,
      deliveryBranch: `dispatch/${HANDOFF_ID}`,
      deliverySha,
      registry: r,
    });

    it('runs a stored red delivery again and rewrites the evidence', async () => {
      deliverySha = await deliver({ 'bad.sh': 'exit 1\n' });
      const reg = registry({ commands: [{ name: 'bad', argv: ['bash', 'bad.sh'], timeout_ms: 30_000 }] });
      const first = await evidenceForDelivery(opts(reg));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await evidenceForDelivery(opts(reg));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.data.outcome).toBe('fail');
      expect(second.data.started_at).not.toBe(first.data.started_at);
      const onDisk = await readValidationEvidence(join(repo, '.agent-runs', 'runs', HANDOFF_ID, RUN_ID, VALIDATION_EVIDENCE_FILE));
      expect(onDisk.ok && onDisk.data?.started_at).toBe(second.data.started_at);
    });

    it('does not run a stored green delivery again', async () => {
      deliverySha = await deliver({ 'ok.sh': 'echo hi\n' });
      const reg = registry({ commands: [{ name: 'ok', argv: ['bash', 'ok.sh'], timeout_ms: 30_000 }] });
      const spy = vi.spyOn(spawnIsolatedModule, 'spawnIsolated');
      try {
        await evidenceForDelivery(opts(reg));
        await evidenceForDelivery(opts(reg));
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Why: a red delivery also runs the same steps on the base commit so a reviewer sees both facts;
  // the baseline never changes the outcome and never runs for a green delivery.
  describe('baseline on the base commit when the delivery is red', () => {
    const cmd = registry({ commands: [{ name: 'test', argv: ['bash', 't.sh'], timeout_ms: 30_000 }] });

    /** Commit `files` on the current branch (the merge target); returns the new HEAD. */
    async function commitOnBase(files: Record<string, string>): Promise<string> {
      for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base change');
      return git(repo, 'rev-parse', 'HEAD');
    }

    it('records a failing baseline for the same command and still reports fail', async () => {
      const baseSha = await commitOnBase({ 't.sh': 'exit 1\n' });
      deliverySha = await deliver({ 'extra.txt': 'x\n' });
      const result = await run(cmd);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.outcome).toBe('fail');
      expect(result.data.baseline).toMatchObject({ status: 'ran', base_sha: baseSha });
      const rendered = renderValidationEvidence(result.data);
      expect(rendered).toContain(`failed on the delivery; failed on the base commit \`${baseSha.slice(0, 12)}\``);
      expect(summarizeValidation(result.data)).toEqual({
        status: 'fail',
        failedCommands: ['test'],
        baseline: { status: 'ran', alsoFailing: ['test'] },
      });
    });

    it('records a passing baseline when the base commit is green, and still reports fail', async () => {
      const baseSha = await commitOnBase({ 't.sh': 'exit 0\n' });
      deliverySha = await deliver({ 't.sh': 'exit 1\n' });
      const result = await run(cmd);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.outcome).toBe('fail');
      expect(result.data.baseline).toMatchObject({ status: 'ran', base_sha: baseSha, commands: [{ name: 'test', result: 'pass' }] });
      expect(renderValidationEvidence(result.data)).toContain(`failed on the delivery; passed on the base commit \`${baseSha.slice(0, 12)}\``);
      expect(summarizeValidation(result.data)).toMatchObject({ baseline: { status: 'ran', alsoFailing: [] } });
    });

    it('runs no baseline for a green delivery', async () => {
      await commitOnBase({ 't.sh': 'exit 1\n' });
      deliverySha = await deliver({ 't.sh': 'exit 0\n' });
      const spy = vi.spyOn(spawnIsolatedModule, 'spawnIsolated');
      try {
        const result = await run(cmd);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.outcome).toBe('pass');
        expect('baseline' in result.data).toBe(false);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('records why when the baseline cannot run, and still reports fail', async () => {
      deliverySha = await deliver({ 't.sh': 'exit 1\n' });
      // The merge target now has no history in common with the delivery: no merge-base.
      git(repo, 'checkout', '-q', '--orphan', 'unrelated');
      git(repo, 'rm', '-rfq', '.');
      await writeFile(join(repo, 'other.txt'), 'other\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'unrelated root');
      const result = await run(cmd);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.outcome).toBe('fail');
      expect(result.data.baseline).toMatchObject({ status: 'not_run', reason: expect.stringContaining('no merge-base') });
      expect(renderValidationEvidence(result.data)).toContain('did not run on the base commit');
      expect(summarizeValidation(result.data)).toMatchObject({ baseline: { status: 'not_run' } });
    });
  });

  // Why: HO validation text is never executed — with no registry the host runs nothing and clones nothing.
  it('runs nothing without a registry and still records evidence', async () => {
    deliverySha = await deliver({ 'x.txt': 'x\n' });
    const result = await run(null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ setup: null, commands: [], outcome: 'pass', registry_fingerprint: validationRegistryFingerprint(null) });
  });

  // Why: WK-0316 AC2 — a deterministic reset of the probe connection (unlike the timing-dependent
  // bash /dev/tcp early close) must raise ECONNRESET on the server socket every time; with the
  // listener in place that is expected and must not crash the run.
  it('survives a client resetting the probe connection (WK-0316)', async () => {
    await new Promise<void>((resolve, reject) => {
      const client = connect(port, '127.0.0.1', () => {
        client.resetAndDestroy();
        resolve();
      });
      client.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toBe(1);
  });
});

describe('readValidationEvidence (WK-0294)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-evidence-read-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Why: a missing file is "no evidence", but a corrupt one must never pass as absent or valid.
  it('returns null for a missing file and refuses a malformed one', async () => {
    const missing = await readValidationEvidence(join(dir, 'none.json'));
    expect(missing).toEqual({ ok: true, data: null });
    await mkdir(join(dir, 'x'), { recursive: true });
    await writeFile(join(dir, 'x', 'bad.json'), JSON.stringify({ schema_version: 1, outcome: 'maybe' }));
    const bad = await readValidationEvidence(join(dir, 'x', 'bad.json'));
    expect(bad.ok).toBe(false);
    expect(await readFile(join(dir, 'x', 'bad.json'), 'utf8')).toContain('maybe');
  });
});

describe('readValidationEvidence baseline field', () => {
  let dir: string;
  const base = { schema_version: 1, run_id: RUN_ID, delivery_sha: 'abc', registry_fingerprint: 'fp', outcome: 'fail', commands: [] };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-evidence-baseline-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function read(value: unknown) {
    const path = join(dir, 'e.json');
    await writeFile(path, JSON.stringify(value));
    return readValidationEvidence(path);
  }

  it('accepts evidence with and without a baseline', async () => {
    expect((await read(base)).ok).toBe(true);
    expect((await read({ ...base, baseline: { status: 'not_run', reason: 'no merge-base' } })).ok).toBe(true);
    expect((await read({ ...base, baseline: { status: 'ran', base_sha: 'def', setup: null, commands: [] } })).ok).toBe(true);
  });

  it('rejects a malformed baseline', async () => {
    expect((await read({ ...base, baseline: 'nope' })).ok).toBe(false);
    expect((await read({ ...base, baseline: { status: 'ran', base_sha: 'def' } })).ok).toBe(false);
    expect((await read({ ...base, baseline: { status: 'not_run' } })).ok).toBe(false);
    expect((await read({ ...base, baseline: { status: 'maybe', reason: 'x' } })).ok).toBe(false);
  });
});

describe('renderValidationEvidence teaching sentence (WK-0306, Resolution 1)', () => {
  function step(overrides: Partial<ValidationStepResult>): ValidationStepResult {
    return {
      name: 'x',
      argv: ['x'],
      network: false,
      exit_code: 0,
      signal: null,
      timed_out: false,
      duration_ms: 1,
      stdout_tail: '',
      stderr_tail: '',
      output_truncated: false,
      result: 'pass',
      ...overrides,
    };
  }

  function evidence(overrides: Partial<ValidationEvidence>): ValidationEvidence {
    return {
      schema_version: 1,
      handoff_id: 'HO-9306',
      run_id: RUN_ID,
      delivery_branch: 'dispatch/HO-9306',
      delivery_sha: 'abc123',
      registry_fingerprint: 'fp',
      started_at: '2026-11-10T00:00:00.000Z',
      completed_at: '2026-11-10T00:00:01.000Z',
      setup: null,
      commands: [],
      outcome: 'pass',
      ...overrides,
    };
  }

  // Why: Resolution 1 — the sentence rides a registered command failure only.
  it('is present when a command fails', () => {
    const rendered = renderValidationEvidence(
      evidence({ commands: [step({ name: 'test', exit_code: 1, result: 'fail' })], outcome: 'fail' }),
    );
    expect(rendered).toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
  });

  it('is absent when every command passes', () => {
    const rendered = renderValidationEvidence(evidence({ commands: [step({ name: 'test' })], outcome: 'pass' }));
    expect(rendered).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
  });

  // Why: Resolution 1 — a setup-only failure means no command ran, so the hermeticity remedy does not apply.
  it('is absent on a setup-only failure (no command ran)', () => {
    const rendered = renderValidationEvidence(
      evidence({ setup: step({ name: 'setup', network: true, exit_code: 1, result: 'fail' }), commands: [], outcome: 'fail' }),
    );
    expect(rendered).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
  });

  describe('merge refusal text (validationGateRefusal)', () => {
    const OVERRIDE_SENTENCE = 'An override needs an explicit operator instruction.';
    const red = (baseline?: ValidationEvidence['baseline']) =>
      evidence({ commands: [step({ name: 'test', exit_code: 1, result: 'fail' })], outcome: 'fail', ...(baseline === undefined ? {} : { baseline }) });
    const refusal = (e: ValidationEvidence | null, problems = ['host validation failed (test)']) =>
      validationGateRefusal('dispatch/HO-0001', problems, e);

    it('red and passing on the base commit: the delivery introduced it; next step is a fix-up handoff; no jail-only sentence', () => {
      const text = refusal(red({ status: 'ran', base_sha: 'b'.repeat(40), setup: null, commands: [step({ name: 'test' })] }));
      expect(text).toContain('Host validation gate refused merge of dispatch/HO-0001: host validation failed (test).');
      expect(text).toContain('The base commit passes the same commands, so this delivery introduced the failure.');
      expect(text).toContain('dispatch a fix-up handoff with base_ref: dispatch/HO-0001, then call merge-delivery on the fix-up handoff');
      expect(text).toContain(OVERRIDE_SENTENCE);
      expect(text).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
      expect(text).not.toContain('Fix the cause and call merge-delivery again');
    });

    it('red and also failing on the base commit: not specific to this delivery; host fix; jail-only sentence kept', () => {
      const text = refusal(red({ status: 'ran', base_sha: 'b'.repeat(40), setup: null, commands: [step({ name: 'test', exit_code: 1, result: 'fail' })] }));
      expect(text).toContain('The same commands also fail on the base commit (test), so the failure is not specific to this delivery.');
      expect(text).toContain('fix the failing command\'s host dependency or the base commit, then call merge-delivery again');
      expect(text).toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
      expect(text).toContain(OVERRIDE_SENTENCE);
      expect(text).not.toContain('fix-up handoff');
    });

    it('red and the baseline did not run: not specific to this delivery; host fix; jail-only sentence kept', () => {
      const text = refusal(red({ status: 'not_run', reason: 'no merge-base' }));
      expect(text).toContain('The same commands did not run on the base commit (no merge-base), so the failure is not known to be specific to this delivery.');
      expect(text).toContain('then call merge-delivery again');
      expect(text).toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
      expect(text).toContain(OVERRIDE_SENTENCE);
      expect(text).not.toContain('fix-up handoff');
    });

    it('a problem that is not a red result keeps "fix the cause and call merge-delivery again"', () => {
      const text = refusal(null, ['review HO-0002 carries no reviewed_sha stamp']);
      expect(text).toContain('Fix the cause and call merge-delivery again');
      expect(text).toContain(OVERRIDE_SENTENCE);
      expect(text).not.toContain(JAIL_HERMETICITY_TEACHING_SENTENCE);
      expect(text).not.toContain('fix-up handoff');
    });
  });
});

describe('loadValidationRegistry (WK-0294)', () => {
  let dir: string;

  async function writeRegistry(value: unknown): Promise<void> {
    await mkdir(join(dir, 'wiki', '.dispatch'), { recursive: true });
    await writeFile(join(dir, 'wiki', '.dispatch', 'validation.json'), typeof value === 'string' ? value : JSON.stringify(value));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-validation-registry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Why: a repo that registers nothing is valid — the host then runs nothing.
  it('returns null when validation.json is absent', async () => {
    expect(await loadValidationRegistry(dir)).toEqual({ ok: true, data: null });
  });

  it('loads a full registry', async () => {
    await writeRegistry({
      schema_version: 1,
      setup: { argv: ['npm', 'ci', '--ignore-scripts'], timeout_ms: 600000 },
      commands: [{ name: 'test', argv: ['npm', 'test'], timeout_ms: 600000 }],
      env: { CI_LIKE: '1' },
      runtime_paths: ['/opt/runtime'],
    });
    const result = await loadValidationRegistry(dir);
    expect(result).toEqual({
      ok: true,
      data: {
        setup: { argv: ['npm', 'ci', '--ignore-scripts'], timeout_ms: 600000 },
        commands: [{ name: 'test', argv: ['npm', 'test'], timeout_ms: 600000 }],
        env: { CI_LIKE: '1' },
        runtime_paths: ['/opt/runtime'],
      },
    });
  });

  // Why: this file decides what the host executes — anything unexpected refuses (strict, like profiles.json).
  it.each([
    ['an unknown top-level key', { schema_version: 1, commands: [], shell: true }],
    ['a shell string instead of argv', { schema_version: 1, commands: [{ name: 't', argv: 'npm test', timeout_ms: 1 }] }],
    ['a missing timeout', { schema_version: 1, commands: [{ name: 't', argv: ['npm', 'test'] }] }],
    ['a duplicate name', { schema_version: 1, commands: [{ name: 't', argv: ['a'], timeout_ms: 1 }, { name: 't', argv: ['b'], timeout_ms: 1 }] }],
    ['a reserved env var', { schema_version: 1, commands: [], env: { PATH: '/evil' } }],
    ['a relative runtime path', { schema_version: 1, commands: [], runtime_paths: ['node/bin'] }],
    ['a wrong schema_version', { schema_version: 2, commands: [] }],
    ['malformed JSON', '{ "schema_version": 1,'],
  ])('refuses %s', async (_label, value) => {
    await writeRegistry(value);
    const result = await loadValidationRegistry(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
  });

  // Why: the merge gate compares fingerprints (A4.5) — formatting must not matter, a change in what runs must.
  it('fingerprints content, not formatting', async () => {
    const a = registry({ commands: [{ name: 't', argv: ['npm', 'test'], timeout_ms: 1 }], env: { B: '2', A: '1' } });
    const b = registry({ env: { A: '1', B: '2' }, commands: [{ timeout_ms: 1, argv: ['npm', 'test'], name: 't' }] });
    const c = registry({ commands: [{ name: 't', argv: ['npm', 'run', 'test'], timeout_ms: 1 }], env: { A: '1', B: '2' } });
    expect(validationRegistryFingerprint(a)).toBe(validationRegistryFingerprint(b));
    expect(validationRegistryFingerprint(a)).not.toBe(validationRegistryFingerprint(c));
    expect(validationRegistryFingerprint(null)).not.toBe(validationRegistryFingerprint(registry()));
  });
});

describe.skipIf(!BWRAP_FUNCTIONAL)('derive-review -> merge-delivery with a real registry (WK-0294)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kb-host-validation-chain-'));
    await mkdir(join(repo, 'wiki', '.dispatch'), { recursive: true });
    const boot = await bootstrap({ dir: repo, repo: 'test/repo' });
    if (!boot.ok) throw new Error(boot.message);
    await writeFile(join(repo, '.gitignore'), '.agent-runs/\n');
    await writeSliceWorkItem(repo, 'WK-9294', { write_scope: ['src/'], validation: 'npm test' });
    await writeFile(
      join(repo, 'wiki', '.dispatch', 'validation.json'),
      JSON.stringify({
        schema_version: 1,
        commands: [
          { name: 'passes', argv: ['bash', '-c', 'echo fine'], timeout_ms: 30000 },
          { name: 'fails', argv: ['bash', '-c', 'echo "boom: 1 test failed" >&2; exit 4'], timeout_ms: 30000 },
        ],
      }),
    );
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Why: the whole A1 chain on a real host run — failing evidence derives a review, blocks the merge, and only an
  // audited override merges it.
  it('derives a review carrying the failing tail, then gates the merge on it', async () => {
    const implement = await createHandoff({
      dir: repo,
      subject: 'kb:dispatch',
      allowed_agents: ['claude'],
      wk: 'WK-9294',
      slice: SLICE_ID,
    });
    if (!implement.ok) throw new Error(implement.message);
    const id = implement.data.handoffId;
    await writeFile(join(repo, 'wiki', 'handoffs', `${id}.response.md`), `---\nhandoff_id: ${id}\n---\n\nDone.\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'implement delivered');
    git(repo, 'checkout', '-q', '-b', `dispatch/${id}`);
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `dispatch: ${id}`);
    const deliverySha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-');
    const runDir = join(repo, '.agent-runs', 'runs', id, RUN_ID);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'state.json'),
      JSON.stringify({ schema_version: 2, status: 'delivered', outcome: 'delivered', branch: `dispatch/${id}`, completed_at: '2026-11-09T00:00:00.000Z' }),
    );

    const derived = await deriveReview({ dir: repo, handoff_id: id });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.data.validation).toMatchObject({ delivery_sha: deliverySha, run_id: RUN_ID, outcome: 'fail' });
    expect(derived.data.validation.commands.map((c) => [c.name, c.result, c.exit_code])).toEqual([
      ['passes', 'pass', 0],
      ['fails', 'fail', 4],
    ]);
    const reviewHo = await readFile(derived.data.reviewPath, 'utf8');
    expect(reviewHo).toContain('boom: 1 test failed');
    expect(reviewHo).toContain(deliverySha);

    // The review itself passes; only the host evidence fails.
    await writeFile(
      join(repo, 'wiki', 'handoffs', `${derived.data.reviewId}.response.md`),
      '---\nrecovery_outcome: no_findings\nrecovery_valid: true\nworker_report_chars: 120\n---\n\nReviewed.\n',
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'review done');

    const refused = await mergeDelivery({ dir: repo, handoff_id: id });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain('host validation failed (fails)');

    const merged = await mergeDelivery({
      dir: repo,
      handoff_id: id,
      override: { reason: 'known failure, fix tracked separately', actor: 'operator', surface: 'api' },
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.data).toMatchObject({ gate: 'override', mergedSha: deliverySha });
    expect(git(repo, 'log', '--format=%s', '-n', '5')).toContain(`merge-delivery override for ${id}`);
  }, 60_000);
});
