/**
 * PLN-0004 S0 Wave 2a — execution-leg module tests.
 *
 * D6 Phase 2 (mid_project_review_rulings.md ruling 7) deleted wsl2.ts
 * entirely (`execViaWsl2`/`classifySignalExit`/`windowsToWslPath`/
 * `resolveWinHostIp` — the Windows-to-WSL2 transport shim; the orchestrator
 * now runs natively on Linux, so there is no cross-OS boundary left to
 * cross). This file's coverage of those functions is removed along with
 * them. `buildJailArgs` (jail.ts) survives D6 unchanged — it shares its
 * mount-logic walk with the new `buildBwrapPlan` and stays independently
 * tested here; see also tests/dispatch-v2-jail.test.ts for its fuller
 * mount-recipe coverage.
 *
 * The old WSL2-dependent live-clone group (createClone/removeClone/
 * sweepOrphanClones against a real `wsl.exe`, gated on `process.platform ===
 * 'win32'`) is also removed: it was already a no-op on every non-Windows
 * host (including this Linux dev rig, both before and after D6), and a
 * proper Linux-native live-clone harness (gated on bwrap/host availability,
 * mirroring dispatch-v2-enforcement.test.ts's `KB_DISPATCH_LIVE_TESTS`
 * pattern) is new test-design work Phase 3 owns, not a mechanical swap.
 */
import { describe, expect, it } from 'vitest';

import { buildJailArgs } from '../packages/dispatch-core/src/jail.js';

// ---------------------------------------------------------------------------
// buildJailArgs — no live host required
// ---------------------------------------------------------------------------

describe('buildJailArgs', () => {
  it('ends with a bare "--" so the caller can append the worker invocation', () => {
    const result = buildJailArgs({ clonePath: '/tmp/x' });
    expect(result.argv[result.argv.length - 1]).toBe('--');
  });
});
