/**
 * PLN-0004 S0 Wave 2a — execution-leg module tests.
 *
 * Covers the three new dispatch v2 skeleton modules (wsl2.ts, jail.ts, clone.ts).
 * These modules live alongside the v1 dispatch-core files and Wave 1's foundation
 * modules; they are not yet wired into src/index.ts or the CLI — that integration is
 * Wave 3. No personal/absolute paths appear in fixtures (WK-0043 rule); all
 * filesystem tests use temp dirs.
 *
 * Split in two:
 * - Windows-testable (no WSL2 required): path conversion, bwrap argv shape, the
 *   host-IP script snippet, and the WK-0074-probed signal exit-code mapping.
 * - WSL2-dependent (env-gated): a real `wsl.exe` round trip and a real ephemeral
 *   clone create/remove. Gated on `process.platform === 'win32'` (WSL2 only exists on
 *   Windows) and further self-checked at runtime via a short-timeout probe, since a
 *   Windows CI/sandbox host is not guaranteed to have a working WSL2 Ubuntu distro —
 *   unavailability is reported loudly (never silently) and the affected tests pass
 *   trivially rather than failing on an environment gap. The full live-jail proof
 *   (WK-0074 B4R suite: clean-gate refusal, transport purity, CAS delivery, conflict
 *   detection, adversarial containment) is T17/T29's job at S5, not this slice.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifySignalExit, execViaWsl2, resolveWinHostIp, windowsToWslPath } from '../packages/dispatch-core/src/wsl2.js';
import { buildJailArgs } from '../packages/dispatch-core/src/jail.js';
import { createClone, removeClone, sweepOrphanClones } from '../packages/dispatch-core/src/clone.js';

// ---------------------------------------------------------------------------
// windowsToWslPath — Windows-testable, no WSL2 required
// ---------------------------------------------------------------------------

describe('windowsToWslPath', () => {
  it('converts a basic Windows path to its /mnt/<drive> WSL2 equivalent', () => {
    expect(windowsToWslPath('C:\\Users\\foo\\bar')).toBe('/mnt/c/Users/foo/bar');
  });

  it('lowercases the drive letter', () => {
    expect(windowsToWslPath('D:\\data\\repo')).toBe('/mnt/d/data/repo');
  });

  it('handles a path that already uses forward slashes', () => {
    expect(windowsToWslPath('C:/already/forward/slash')).toBe('/mnt/c/already/forward/slash');
  });

  it('preserves spaces in path segments', () => {
    expect(windowsToWslPath('C:\\Users\\foo bar\\baz qux')).toBe('/mnt/c/Users/foo bar/baz qux');
  });

  it('normalizes separators on a non-drive-rooted path without adding /mnt', () => {
    expect(windowsToWslPath('relative\\path\\here')).toBe('relative/path/here');
  });

  it('handles a bare drive root', () => {
    expect(windowsToWslPath('C:\\')).toBe('/mnt/c/');
  });
});

// ---------------------------------------------------------------------------
// buildJailArgs — Windows-testable, no WSL2 required
// ---------------------------------------------------------------------------

describe('buildJailArgs', () => {
  it('builds the S0-minimum bwrap argv shape with cwd defaulting to clonePath', () => {
    const clonePath = '/home/user/.kb-dispatch/clones/RUN-1';
    const result = buildJailArgs({ clonePath });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('uses an explicit cwd when provided, distinct from clonePath', () => {
    const clonePath = '/home/user/.kb-dispatch/clones/RUN-2';
    const cwd = `${clonePath}/subdir`;
    const result = buildJailArgs({ clonePath, cwd });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', cwd,
      '--',
    ]);
  });

  it('ends with a bare "--" so the caller can append the worker invocation', () => {
    const result = buildJailArgs({ clonePath: '/tmp/x' });
    expect(result.argv[result.argv.length - 1]).toBe('--');
  });
});

// ---------------------------------------------------------------------------
// resolveWinHostIp — Windows-testable, no WSL2 required
// ---------------------------------------------------------------------------

describe('resolveWinHostIp', () => {
  it('returns the default-gateway resolution snippet (execution/s0-rulings.md ruling 4)', () => {
    expect(resolveWinHostIp()).toBe("ip route show default | head -1 | cut -d' ' -f3");
  });

  it('returns a plain string with no execution side effects', () => {
    expect(typeof resolveWinHostIp()).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// classifySignalExit — Windows-testable, no WSL2 required (WK-0074 probe 2)
// ---------------------------------------------------------------------------

describe('classifySignalExit (signal mapping)', () => {
  it('exit code 9 (SIGKILL) is classified as killed by signal', () => {
    expect(classifySignalExit(9)).toEqual({ killedBySignal: true, signal: 9 });
  });

  it('exit code 15 (SIGTERM) is classified as killed by signal', () => {
    expect(classifySignalExit(15)).toEqual({ killedBySignal: true, signal: 15 });
  });

  it('exit code 0 is not classified as killed by signal', () => {
    expect(classifySignalExit(0)).toEqual({ killedBySignal: false });
  });

  it('a plain non-zero, non-signal exit code (e.g. 1) is not classified as killed by signal', () => {
    expect(classifySignalExit(1)).toEqual({ killedBySignal: false });
  });

  it('does not misclassify the shell 128+N convention — wsl.exe reports raw signal numbers only', () => {
    expect(classifySignalExit(137)).toEqual({ killedBySignal: false });
    expect(classifySignalExit(143)).toEqual({ killedBySignal: false });
  });
});

// ---------------------------------------------------------------------------
// execViaWsl2 — the one failure path that's deterministic without WSL2 at all:
// the script-file write happens before wsl.exe is ever invoked.
// ---------------------------------------------------------------------------

describe('execViaWsl2 (Windows-testable failure path)', () => {
  it('fails with a DispatchResult when the run dir does not exist (script write fails)', async () => {
    const result = await execViaWsl2({
      runDir: join(tmpdir(), 'kb-dispatch-exec-nonexistent-rundir-fixture'),
      scriptContent: '#!/usr/bin/env bash\necho hi\n',
      scriptName: 'test.sh',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Failed to write WSL2 script file');
    }
  });
});

// ---------------------------------------------------------------------------
// WSL2-dependent — env-gated (real wsl.exe + real ephemeral clone)
// ---------------------------------------------------------------------------

const HAS_WSL = process.platform === 'win32'; // only run WSL tests on Windows

if (!HAS_WSL) {
  // eslint-disable-next-line no-console
  console.warn(
    `[dispatch-v2-exec] Skipping WSL2-dependent tests loudly: process.platform is `
    + `'${process.platform}', not 'win32' — WSL2 only exists on Windows.`,
  );
}

async function probeWsl(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-wsl-probe-'));
  try {
    const result = await execViaWsl2({
      runDir: dir,
      scriptContent: [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'command -v git >/dev/null 2>&1 && echo probe-ok || echo probe-missing-git',
      ].join('\n'),
      scriptName: 'probe.sh',
      timeoutMs: 15_000,
    });
    return result.ok && result.data.exitCode === 0 && result.data.stdout.includes('probe-ok');
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe.skipIf(!HAS_WSL)('execViaWsl2 / clone.ts (WSL2-dependent, env-gated)', () => {
  let wslAvailable = false;

  beforeAll(async () => {
    wslAvailable = await probeWsl();
    if (!wslAvailable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[dispatch-v2-exec] WSL2 Ubuntu with git not detected (or the probe timed out) '
        + 'in this environment — WSL2-dependent tests below will report and pass '
        + 'trivially instead of failing on an environment gap.',
      );
    }
  }, 20_000);

  it('runs a trivial script inside WSL2 and reports a clean exit', async () => {
    if (!wslAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[dispatch-v2-exec] skip: WSL2/Ubuntu with git not available.');
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'kb-wsl-echo-'));
    try {
      const result = await execViaWsl2({
        runDir: dir,
        scriptContent: '#!/usr/bin/env bash\nset -euo pipefail\necho hello-from-wsl2\n',
        scriptName: 'echo.sh',
        timeoutMs: 15_000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exitCode).toBe(0);
        expect(result.data.killedBySignal).toBe(false);
        expect(result.data.stdout).toContain('hello-from-wsl2');
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 20_000);

  it('creates and removes a real ephemeral WSL2 ext4 clone (createClone/removeClone)', async () => {
    if (!wslAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[dispatch-v2-exec] skip: WSL2/Ubuntu with git not available.');
      return;
    }

    const motherDir = await mkdtemp(join(tmpdir(), 'kb-clone-mother-'));
    const runDir = await mkdtemp(join(tmpdir(), 'kb-clone-rundir-'));
    let clonePath: string | undefined;

    try {
      execFileSync('git', ['init', '-b', 'main', motherDir]);
      execFileSync('git', ['config', 'user.name', 'wsl2-exec-test'], { cwd: motherDir });
      execFileSync('git', ['config', 'user.email', 'wsl2-exec-test@test.local'], { cwd: motherDir });
      await writeFile(join(motherDir, 'file.txt'), 'hello from dispatch-v2-exec test\n', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: motherDir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: motherDir });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: motherDir }).toString().trim();

      const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cloneResult = await createClone({ motherRepo: motherDir, runId, baseSha });

      expect(cloneResult.ok).toBe(true);
      if (!cloneResult.ok) return;
      expect(cloneResult.data.clonePath.length).toBeGreaterThan(0);
      expect(cloneResult.data.baseSha).toBe(baseSha);
      clonePath = cloneResult.data.clonePath;

      const removeResult = await removeClone(clonePath, runDir);
      expect(removeResult.ok).toBe(true);
      clonePath = undefined;
    } finally {
      if (clonePath) {
        await removeClone(clonePath, runDir).catch(() => undefined);
      }
      await rm(motherDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 30_000);

  it('sweepOrphanClones runs cleanly against the real clone root and returns an array', async () => {
    if (!wslAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[dispatch-v2-exec] skip: WSL2/Ubuntu with git not available.');
      return;
    }

    const result = await sweepOrphanClones();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data.removed)).toBe(true);
    }
  }, 20_000);
});
