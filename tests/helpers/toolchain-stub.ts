/**
 * Test helper: pin `resolveToolchainPaths`'s (pipeline.ts) host probes to
 * SYSTEM_ROOTS paths. `resolveToolchainPaths` resolves the family's CLI,
 * `node` and `npm prefix -g` through exec-direct.ts's `execBash`, then
 * refuses `CLI_PATH_NOT_MOUNTABLE` when one lands outside `$HOME` and
 * `SYSTEM_ROOTS` (mountability.ts). A test that points `$HOME` at a
 * throwaway dir would otherwise resolve the real host toolchain outside that
 * `$HOME` and refuse before ever reaching the seam under test.
 *
 * `stubToolchainProbes` intercepts only the four exact probe strings below;
 * every other `execBash` call runs the real function, so a file's "mostly
 * real runDispatch()" contract (stage, land, preflight, fingerprinting) is
 * preserved.
 *
 * One `execBash` spy is installed per test and reused when the same test
 * calls this again for a second CLI (a global default `pi` plus a per-test
 * `claude`), so paths accumulate instead of nesting spies — nesting would
 * make the outer spy the captured `real`, i.e. recurse forever.
 */
import { vi } from 'vitest';

import * as execDirectModule from '../../packages/dispatch-core/src/exec-direct.js';
import { ok as dispatchOk } from '../../packages/dispatch-core/src/errors.js';

const pathStubs = new Map<string, string>();
let installedSpy: unknown;

export function stubToolchainProbes(cli: { name: string; path: string }): void {
  if (installedSpy !== execDirectModule.execBash) {
    pathStubs.clear();
    const real = execDirectModule.execBash;
    installedSpy = vi.spyOn(execDirectModule, 'execBash').mockImplementation(async (opts) => {
      const stubbed = pathStubs.get(opts.scriptContent);
      if (stubbed !== undefined) {
        return dispatchOk({ stdout: stubbed, stderr: '', exitCode: 0 });
      }
      return real(opts);
    });
  }
  // Every path returned here is under a SYSTEM_ROOTS entry, so the resolved
  // result is independent of the host and of `$HOME`.
  pathStubs.set(`command -v ${cli.name} 2>/dev/null`, cli.path);
  pathStubs.set(`readlink -f ${cli.path} 2>/dev/null`, cli.path);
  pathStubs.set('command -v node 2>/dev/null', '/usr/bin/node');
  pathStubs.set('readlink -f /usr/bin/node 2>/dev/null', '/usr/bin/node');
  pathStubs.set('npm prefix -g 2>/dev/null', '/usr');
}
