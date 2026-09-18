/**
 * PLN-0004 D6 Phase 3 — execBash unit tests (exec-direct.ts).
 *
 * D6 Phase 2 deleted wsl2.ts; `execBash` (`execFile('bash', ['-c', ...])`) is
 * its replacement for the native-Linux transport. Every test below runs REAL
 * bash directly -- bash is universally available on this project's
 * native-Linux target, so no `node:child_process` mock is needed anywhere,
 * including the EXEC_FAILED case (it triggers a genuine ENOENT by pointing
 * `opts.env.PATH` at a directory that does not exist).
 *
 * Two facts below were confirmed against a live `promisify(execFile)` call
 * before being asserted -- never assumed from exec-direct.ts's own comments:
 * a signal-killed child throws with `.signal` set and `.code === null`, and
 * exec-direct.ts's SIGNAL_TO_NUMBER table maps SIGTERM to the bare signal
 * number 15, NOT the 128+N shell convention (128+15 = 143) its doc comment
 * names. The timeout test below asserts the real value, 15.
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';

import type { DispatchResult } from '../packages/dispatch-core/src/errors.js';
import { execBash, type ExecBashResult } from '../packages/dispatch-core/src/exec-direct.js';

/** Unwrap an `ok(...)` result, failing with the error code/message if it isn't one. */
function expectOk(result: DispatchResult<ExecBashResult>): ExecBashResult {
  if (!result.ok) throw new Error(`expected ok(...), got fail: ${result.error} -- ${result.message}`);
  return result.data;
}

describe('execBash', () => {
  it('happy path: a clean script exits 0 with its stdout captured', async () => {
    const data = expectOk(await execBash({ scriptContent: 'echo hello' }));
    expect(data).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' });
  });

  it('non-zero exit: still ok(...), not a fail -- the caller decides what the code means', async () => {
    const data = expectOk(await execBash({ scriptContent: 'echo before-exit; exit 42' }));
    expect(data.exitCode).toBe(42);
    expect(data.stdout).toBe('before-exit\n'); // output before the exit isn't dropped on the error path
  });

  it('timeout: a signal-killed script is still ok(...) with a nonzero exit code', async () => {
    const data = expectOk(await execBash({ scriptContent: 'sleep 10', timeoutMs: 100 }));
    // SIGTERM -> 15 per exec-direct.ts's SIGNAL_TO_NUMBER table (see file header).
    expect(data.exitCode).toBe(15);
  });

  it('error result: bash cannot be spawned at all -> fail(EXEC_FAILED), no mocking required', async () => {
    const result = await execBash({
      scriptContent: 'echo unreachable',
      env: { PATH: '/definitely-not-a-real-dir-xyz' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('EXEC_FAILED');
    expect((result.detail as { code?: string } | undefined)?.code).toBe('ENOENT');
  });

  it('captures stdout and stderr as separate streams from the same script', async () => {
    const data = expectOk(await execBash({ scriptContent: 'echo out-line; echo err-line 1>&2' }));
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe('out-line\n');
    expect(data.stderr).toBe('err-line\n');
  });

  it('passes opts.env through to the child, merged over process.env', async () => {
    const data = expectOk(await execBash({ scriptContent: 'echo "$MY_VAR"', env: { MY_VAR: 'from-opts' } }));
    expect(data.stdout).toBe('from-opts\n');
  });

  it('respects opts.cwd for the spawned process', async () => {
    const dir = tmpdir();
    const data = expectOk(await execBash({ scriptContent: 'pwd', cwd: dir }));
    expect(data.stdout.trim()).toBe(dir);
  });
});
