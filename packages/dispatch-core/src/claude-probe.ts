/**
 * Claude permission launch probe (WK-0131 step 4), split out of pipeline.ts
 * into its own module so tests can mock it: in ESM, `vi.spyOn` on a module
 * namespace only intercepts calls made THROUGH that namespace object —
 * pipeline.ts's own call site referenced the function directly (an
 * intra-module call), which a spy on pipeline.ts's exports can never see.
 * Living in its own module makes the probe interceptable exactly like
 * pipeline.ts's other collaborators (spawn-isolated.ts, tier.ts,
 * preflight.ts) already are in the e2e tests.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

/**
 * Host-side launch probe for Claude implement dispatches (WK-0131 step 4;
 * mirrors agent-chassis's `defaultRunClaudeNativePermissionProbe`). Verifies,
 * on THIS Claude CLI version, that a Write tool call lands under an
 * Edit-only allow entry (`buildClaudeSettingsJson` grants `Edit(...)`, never
 * `Write(...)`, per that function's own doc comment) before the real worker
 * is ever spawned — the exact scenario that silently failed in the S6c gate
 * capture (HO-0034: Write denied on an in-scope path). Runs on the bare
 * host, outside bwrap: this probes the SETTINGS-LAYER permission grant only,
 * a property of the `claude` binary itself, independent of the jail's own
 * kernel-level enforcement (tested separately by the fake-tier jail-plan
 * assertions).
 *
 * `writeScope` is `handoff.write_scope` (unwidened, clone-relative entries —
 * the same input `buildClaudeSettingsJson` itself takes); empty is
 * defensively accepted as a no-op success since advisory modes (empty
 * write_scope by construction) never call this.
 */
export async function runClaudePermissionProbe(
  settingsContent: string,
  writeScope: string[],
): Promise<DispatchResult<void>> {
  if (writeScope.length === 0) return ok(undefined);
  const scopeDir = writeScope[0]!.replace(/^\/+/, '').replace(/\/+$/, '');

  const probeDir = await mkdtemp(join(tmpdir(), 'kb-probe-'));
  try {
    await mkdir(join(probeDir, scopeDir), { recursive: true });
    const settingsPath = join(probeDir, '.claude-settings.json');
    await writeFile(settingsPath, settingsContent);

    const prompt = [
      `Write the text "probe" to the file ${scopeDir}/PROBE_OK.txt using the Write tool.`,
      'Then write the text "probe" to the file PROBE_DENIED.txt using the Write tool.',
    ].join('\n');

    await new Promise<void>((resolveProbe) => {
      const child = spawn(
        'claude',
        ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', settingsPath, '--', prompt],
        { cwd: probeDir, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      // Drain stdout/stderr — an unconsumed pipe fills its OS buffer once the
      // child writes enough output, which would otherwise block the child
      // indefinitely instead of exiting (the probe only cares about the
      // filesystem side effect, never the transcript).
      child.stdout?.on('data', () => undefined);
      child.stderr?.on('data', () => undefined);

      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill();
        resolveProbe();
      }, 30_000);

      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveProbe();
      });
      child.once('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveProbe();
      });
    });

    const inScopeCreated = existsSync(join(probeDir, scopeDir, 'PROBE_OK.txt'));
    const outOfScopeCreated = existsSync(join(probeDir, 'PROBE_DENIED.txt'));

    if (!inScopeCreated) {
      return fail(
        'CLAUDE_PERMISSION_PROBE_FAILED',
        'Claude permission probe: Write under Edit-only allow failed — in-scope file was not created. The current Claude CLI version may not cover Write with Edit patterns. Consider adding explicit Write(...) entries.',
      );
    }
    if (outOfScopeCreated) {
      return fail(
        'CLAUDE_PERMISSION_PROBE_FAILED',
        'Claude permission probe: out-of-scope file was created — deny list or scope boundary is not working.',
      );
    }
    return ok(undefined);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}
