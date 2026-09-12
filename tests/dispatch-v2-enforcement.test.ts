/**
 * PLN-0004 S5 T29/T17 — env-gated live-tier tests (real bwrap+WSL2) plus a
 * small fake-tier gap-fill.
 *
 * The rest of the v2 suite is 100%-Windows-runnable by design (DEC-0006):
 * jail.ts/tunnel.ts/pipeline.ts are proven via string-content assertions
 * against generated bwrap argv / bash script text, never a live host. T29
 * adds the NEW permanent tier this file lives in: tests that actually spawn
 * `wsl.exe`, run real `bwrap`, and touch a real git clone. They require a
 * working bwrap+WSL2 host (or native Linux with bwrap) and are gated behind
 * `KB_DISPATCH_LIVE_TESTS=1` — absent, every live group below SKIPS LOUDLY
 * (a real `console.warn` explaining exactly why + how to enable them, not a
 * silent omission — see `describeIfLive` below for how that's guaranteed).
 *
 * Structure:
 *   - Group 4 (always runs, fake-tier): a small gap-fill for the wiki-shape
 *     x mode matrix not already covered by dispatch-v2-jail.test.ts. Items
 *     13-15 from the T17 tracker line are FULLY covered already by
 *     dispatch-v2-jail.test.ts (`--unshare-net`) and
 *     dispatch-v2-pipeline-s5.test.ts (tunnel splice / lo-up) — verified by
 *     reading both files first; deliberately NOT duplicated here.
 *   - Group 1 (live, T17 items 1-5): the WK-0074 B4R suite ported to a
 *     permanent test — clean-gate refusal, transport purity, CAS delivery
 *     parent = base_sha, idempotent redelivery, conflict detection. Exercises
 *     admission.ts/clone.ts/delivery.ts directly against a REAL temp git repo
 *     and a REAL WSL2 clone (not the hand-constructed fake stdout used by
 *     dispatch-v2-e2e.test.ts/dispatch-v2-delivery.test.ts).
 *   - Group 2 (live, T17 items 6-9): adversarial sandbox canary probes.
 *     SAFE ONLY — touch/read/write a harmless sentinel outside the clone
 *     bind, verify it never lands on the host. NEVER a destructive command
 *     (no rm -rf /, no dd, no mkfs — repo standing rule).
 *   - Group 3 (live, T17 items 10-12): egress enforcement proofs (T26/D21) —
 *     web:false denies an arbitrary destination, web:false still reaches the
 *     one granted endpoint through the tunnel, and the in-jail netns brings
 *     `lo` up before the relay binds (s5-rulings.md's named live-tier point).
 *
 * No personal/absolute paths appear in fixtures (WK-0043 rule) — every path
 * below is either a temp dir or a synthetic/example value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseHandoffContent } from '../packages/dispatch-core/src/ho.js';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { createClone, removeClone } from '../packages/dispatch-core/src/clone.js';
import {
  buildEnumerateScript,
  parseEnumerateOutput,
  checkWriteScope,
  buildDeliveryScript,
  parseDeliveryOutput,
} from '../packages/dispatch-core/src/delivery.js';
import { execViaWsl2, windowsToWslPath, type Wsl2ExecResult } from '../packages/dispatch-core/src/wsl2.js';
import { buildJailArgs } from '../packages/dispatch-core/src/jail.js';
import {
  buildTunnelBashLines,
  TUNNEL_RELAY_PORT,
  TUNNEL_SOCKET_NAME,
  type TunnelConfig,
} from '../packages/dispatch-core/src/tunnel.js';

// ---------------------------------------------------------------------------
// T29 env gate
// ---------------------------------------------------------------------------

const LIVE_TIER = process.env.KB_DISPATCH_LIVE_TESTS;

/**
 * T29 env gate. `KB_DISPATCH_LIVE_TESTS=1` opts into the real bwrap+WSL2 (or
 * native Linux+bwrap) tests below; absent, the wrapped group skips — LOUDLY,
 * never silently.
 *
 * Load-bearing detail (verified empirically against this repo's vitest
 * version, not assumed): `describe.skip(name, fn)` still invokes `fn`
 * SYNCHRONOUSLY during vitest's collection phase — every framework needs
 * this to enumerate the skipped suite's shape for the report — but a nested
 * `it(...)`'s own callback body never runs under `.skip`. So the
 * `console.warn` below is placed directly in the `describe.skip` body (where
 * it actually executes on every `npm test` run while the flag is unset), not
 * inside the nested `it` (where it would silently never fire). The nested
 * `it` is kept anyway so the skip reason also shows up as a named, visibly-
 * skipped line in the test report, belt-and-suspenders with the console
 * message.
 */
function describeIfLive(name: string, fn: () => void): void {
  if (LIVE_TIER) {
    describe(name, fn);
    return;
  }
  describe.skip(name, () => {
    console.warn(
      `SKIPPED: "${name}" requires a real bwrap+WSL2 (or native Linux+bwrap) host.\n` +
        'Set KB_DISPATCH_LIVE_TESTS=1 and ensure bwrap is available inside WSL2 (or natively on Linux) to run these live jail/enforcement tests.\n' +
        'These tests are designed to skip loudly, not silently — this message prints on every run until the flag is set.',
    );
    it('SKIPPED: set KB_DISPATCH_LIVE_TESTS=1 to enable live jail/enforcement tests', () => {
      // Never executes — `describe.skip` prevents nested `it` bodies from
      // running at all. The console.warn above (in this describe's own
      // synchronous callback, which DOES run under `.skip`) is the real
      // notification; this `it` exists only to give the skip a named,
      // visible line in the test report.
    });
  });
}

// ---------------------------------------------------------------------------
// Shared live-tier helpers
// ---------------------------------------------------------------------------

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Single-quote a value for safe embedding in generated bash (mirrors the same private helper in pipeline.ts/delivery.ts/tunnel.ts). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stage+run a bash script inside WSL2 via the REAL `execViaWsl2`. Throws only
 * when the exec plumbing itself failed to run at all (e.g. `wsl.exe` missing
 * from PATH) — a live test that sets `KB_DISPATCH_LIVE_TESTS=1` on a host
 * without a working WSL2 SHOULD fail loudly here rather than skip, since the
 * operator explicitly opted in. Callers inspect `exitCode`/`stdout` on the
 * returned `Wsl2ExecResult` themselves for probes that are EXPECTED to fail
 * (e.g. the adversarial canary probes in Group 2).
 */
async function runWsl(
  runDir: string,
  scriptContent: string,
  scriptName: string,
  timeoutMs = 60_000,
): Promise<Wsl2ExecResult> {
  const result = await execViaWsl2({ runDir, scriptContent, scriptName, timeoutMs });
  if (!result.ok) {
    throw new Error(`execViaWsl2 itself failed to run "${scriptName}" (is wsl.exe on PATH?): ${result.message}`);
  }
  return result.data;
}

/**
 * Create a throwaway WSL2-side scratch directory to use as a bwrap bind
 * target for probes that don't need an actual git clone (Groups 2-3). Lives
 * under a distinct `.kb-dispatch-test` root — never the real
 * `~/.kb-dispatch/clones` a live operator run would be using concurrently.
 */
async function createScratchDir(runDir: string, label: string): Promise<string> {
  const dirName = `kb-dispatch-test-${label}-${randomUUID()}`;
  const result = await runWsl(
    runDir,
    ['#!/bin/bash', 'set -euo pipefail', `DIR="$HOME/.kb-dispatch-test/${dirName}"`, 'mkdir -p "$DIR"', 'echo "$DIR"'].join('\n'),
    'mk-scratch.sh',
    30_000,
  );
  const dir = result.stdout.trim().split('\n').pop();
  if (!dir) throw new Error('Failed to create WSL2 scratch dir (no path on stdout).');
  return dir;
}

async function removeScratchDir(runDir: string, wslPath: string): Promise<void> {
  if (!wslPath.includes('.kb-dispatch-test')) return; // safety guard, mirrors clone.ts's own
  await runWsl(runDir, ['#!/bin/bash', 'set -euo pipefail', `rm -rf ${shQuote(wslPath)}`].join('\n'), 'rm-scratch.sh', 30_000);
}

// ---------------------------------------------------------------------------
// Group 4 (T17 item 16 gap-fill) — always runs, no WSL2/bwrap needed.
//
// Items 13-15 (`--unshare-net` in argv, tunnel lines in buildExecutionScript,
// `ip link set lo up` in buildExecutionScript) are ALREADY fully covered:
//   - dispatch-v2-jail.test.ts: "buildJailArgs — unshare-net (T26/D21)"
//   - dispatch-v2-pipeline-s5.test.ts: "buildExecutionScript — tunnel splice"
//     (forwarder start, relay start via RELAY_PID=$!, proxy env) and
//     "brings the loopback interface up inside the jail before starting the
//     relay" (`ip link set lo up`).
// Re-asserted here would be pure duplication — skipped per the task's
// explicit "don't duplicate" instruction.
//
// Item 16 (the wiki-shape x mode matrix) is MOSTLY covered by
// dispatch-v2-jail.test.ts's "buildJailArgs — wiki read axis (T25/D19)"
// describe block, which already proves: tracked+implement (masked),
// tracked+code_review (masked), tracked+redteam (visible), nested-private+
// implement (no-op), nested-private+research+motherWikiPath (bound), and
// nested-private+redteam WITHOUT motherWikiPath (no-op). The 4 distinct
// behavior classes (tracked-masked / tracked-visible / nested-private-masked
// / nested-private-visible) are each proven by at least one mode, but three
// specific mode+shape combinations are never exercised: tracked+research,
// nested-private+code_review, and nested-private+redteam WITH a
// motherWikiPath. This block closes exactly those three gaps.
// ---------------------------------------------------------------------------

describe('buildJailArgs — wiki-shape x mode matrix gap-fill (T25/D19; complements dispatch-v2-jail.test.ts)', () => {
  const clonePath = '/home/user/.kb-dispatch/clones/RUN-MATRIX';

  it('tracked + research: no wiki mask (a visible mode, same behavior class as the already-tested tracked+redteam)', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'tracked', mode: 'research' });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
    // Only one --tmpfs occurrence (the mandatory /tmp scratch mount) -- no
    // extra wiki-mask tmpfs was added for a visible mode.
    expect(result.argv.filter((tok) => tok === '--tmpfs').length).toBe(1);
  });

  it('nested-private + code_review: nothing added (a masked mode, same behavior class as the already-tested nested-private+implement)', () => {
    const result = buildJailArgs({ clonePath, wikiShape: 'nested-private', mode: 'code_review' });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--chdir', clonePath,
      '--',
    ]);
  });

  it('nested-private + redteam WITH motherWikiPath: ro-binds the mother wiki (a visible mode, same bind shape as the already-tested nested-private+research)', () => {
    const motherWikiPath = '/home/user/kb-dev-rig/wiki';
    const result = buildJailArgs({ clonePath, wikiShape: 'nested-private', mode: 'redteam', motherWikiPath });
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--bind', clonePath, clonePath,
      '--ro-bind', motherWikiPath, `${clonePath}/wiki`,
      '--chdir', clonePath,
      '--',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live tier (T29) — Groups 1-3
// ---------------------------------------------------------------------------

describeIfLive(
  'dispatch-v2-enforcement — live tier (T29): B4R suite + adversarial probes + egress proofs',
  () => {
    // -------------------------------------------------------------------
    // Group 1a (T17 item 1) — clean-gate refusal
    // -------------------------------------------------------------------

    function b4rHandoffContent(id: string): string {
      return `---
id: ${id}
title: Enforcement live-test fixture
mode: implement
write_scope: ["src/", "test/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: placeholder -- this HO is never actually dispatched to a worker"
validation: ["true"]
status: draft
---

## Task
Placeholder fixture for the T17 live delivery-pipeline (B4R) tests. No worker
is ever invoked for these tests -- admission/clone/delivery are exercised
directly against a real temp git repo and a real WSL2 clone.
`;
    }

    /** A clean, committed temp git repo with no HO file on disk (parseHandoffContent builds the Handoff in-memory instead — checkAdmission never re-reads the file itself). */
    async function setupB4rRepo(): Promise<string> {
      const repoRoot = await createTempDir('kb-b4r-repo-');
      execFileSync('git', ['init'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
      await writeFile(join(repoRoot, 'README.md'), 'kb-b4r-fixture: a minimal fixture repo for live delivery-pipeline tests.\n', 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
      return repoRoot;
    }

    describe('B4R suite (WK-0074) -- item 1: clean-gate refusal (checkAdmission, real git)', () => {
      it('refuses DIRTY_REPO when the mother repo has uncommitted changes', async () => {
        const repoRoot = await setupB4rRepo();
        try {
          await writeFile(join(repoRoot, 'README.md'), 'modified without committing\n', 'utf8');

          const parsed = parseHandoffContent(b4rHandoffContent('HO-B4R-DIRTY'), 'HO-B4R-DIRTY.md');
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;

          const admission = await checkAdmission(parsed.data, repoRoot);
          expect(admission.ok).toBe(false);
          if (admission.ok) return;
          expect(admission.error).toBe('DIRTY_REPO');
          expect(admission.detail).toMatchObject({
            dirtyPaths: expect.arrayContaining([expect.stringContaining('README.md')]),
          });
        } finally {
          await rm(repoRoot, { recursive: true, force: true });
        }
      }, 30_000);
    });

    // -------------------------------------------------------------------
    // Group 1b (T17 items 2-5) — transport purity, CAS delivery, idempotent
    // redelivery, conflict detection. One shared repo+clone+first-delivery
    // set up once; the four `it`s below build on each other IN ORDER
    // (vitest runs `it`s within one `describe` sequentially by default,
    // matching the chained-state pattern already used by this codebase's
    // other integration-style suites, e.g. dispatch-v2-e2e.test.ts).
    // -------------------------------------------------------------------

    describe('B4R suite (WK-0074) -- items 2-5: transport purity, CAS delivery, idempotent redelivery, conflict detection (real WSL2 clone + delivery)', () => {
      const handoffId = 'HO-B4R-DELIVER';
      let repoRoot: string;
      let runDir: string;
      let clonePath: string;
      let baseSha: string;
      let firstCommitSha: string;

      beforeAll(async () => {
        repoRoot = await setupB4rRepo();
        runDir = await createTempDir('kb-b4r-rundir-');

        const parsed = parseHandoffContent(b4rHandoffContent(handoffId), `${handoffId}.md`);
        if (!parsed.ok) throw new Error(`fixture HO failed to parse: ${parsed.message}`);
        const admission = await checkAdmission(parsed.data, repoRoot);
        if (!admission.ok) throw new Error(`fixture admission failed: ${admission.error} -- ${admission.message}`);
        baseSha = admission.data.baseSha;

        const cloneResult = await createClone({
          motherRepo: repoRoot,
          runId: `RUN-${randomUUID()}`,
          baseSha,
          cloneRoot: '~/.kb-dispatch-test/clones',
        });
        if (!cloneResult.ok) throw new Error(`fixture clone failed: ${cloneResult.message}`);
        clonePath = cloneResult.data.clonePath;

        // Simulate a worker writing two new, in-scope files directly into the clone.
        await runWsl(
          runDir,
          [
            '#!/bin/bash',
            'set -euo pipefail',
            `mkdir -p ${shQuote(`${clonePath}/src`)} ${shQuote(`${clonePath}/test`)}`,
            `echo 'export const a = 1;' > ${shQuote(`${clonePath}/src/a.mjs`)}`,
            `echo 'export const testA = true;' > ${shQuote(`${clonePath}/test/a.test.mjs`)}`,
          ].join('\n'),
          'seed-worker-change.sh',
          30_000,
        );
      }, 60_000);

      afterAll(async () => {
        if (clonePath) await removeClone(clonePath, runDir).catch(() => undefined);
        if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
        if (repoRoot) await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
      }, 60_000);

      it('2. transport purity: delivered files match write_scope exactly (real enumerate + real delivery)', async () => {
        const enumerateScript = buildEnumerateScript(clonePath);
        const enumerateExec = await runWsl(runDir, enumerateScript.scriptContent, enumerateScript.scriptName);
        expect(enumerateExec.exitCode).toBe(0);

        const enumerated = parseEnumerateOutput(enumerateExec.stdout);
        const allChanged = [...enumerated.changedFiles, ...enumerated.untrackedFiles];
        expect([...allChanged].sort()).toEqual(['src/a.mjs', 'test/a.test.mjs']);

        const scopeCheck = checkWriteScope(allChanged, ['src/', 'test/']);
        expect(scopeCheck.ok).toBe(true);

        const deliveryScript = buildDeliveryScript({
          clonePath,
          motherRepoWsl: windowsToWslPath(repoRoot),
          handoffId,
          baseSha,
        });
        const deliveryExec = await runWsl(runDir, deliveryScript.scriptContent, deliveryScript.scriptName);
        expect(deliveryExec.exitCode).toBe(0);

        const delivery = parseDeliveryOutput(deliveryExec.stdout);
        expect(delivery.status).toBe('delivered');
        if (delivery.status !== 'delivered') return;
        expect(delivery.branch).toBe(`dispatch/${handoffId}`);
        // Transport purity: exactly the two write_scope files, nothing more
        // (no .git internals, no worker-infra noise, no dropped file).
        expect([...delivery.changedFiles].sort()).toEqual(['src/a.mjs', 'test/a.test.mjs']);
        firstCommitSha = delivery.commitSha;
      }, 60_000);

      it('3. CAS delivery: the parent of the delivered commit equals base_sha', async () => {
        const parentExec = await runWsl(
          runDir,
          ['#!/bin/bash', 'set -euo pipefail', `git -C ${shQuote(windowsToWslPath(repoRoot))} rev-parse refs/heads/dispatch/${handoffId}^`].join('\n'),
          'check-parent.sh',
        );
        expect(parentExec.exitCode).toBe(0);
        expect(parentExec.stdout.trim()).toBe(baseSha);
      }, 60_000);

      it('4. idempotent redelivery: re-delivering the SAME (unchanged) clone produces no_changes, not a conflict', async () => {
        const deliveryScript = buildDeliveryScript({
          clonePath,
          motherRepoWsl: windowsToWslPath(repoRoot),
          handoffId,
          baseSha,
        });
        const deliveryExec = await runWsl(runDir, deliveryScript.scriptContent, `${deliveryScript.scriptName}-redeliver`);
        expect(deliveryExec.exitCode).toBe(0);

        const delivery = parseDeliveryOutput(deliveryExec.stdout);
        expect(delivery.status).toBe('no_changes');
      }, 60_000);

      it('5. conflict detection: a different tree from the same base refuses as a structured conflict, never a clobber', async () => {
        // Add a third file to the clone -- base_sha is unchanged, but the
        // tree now differs from what's already landed on dispatch/<id>.
        await runWsl(
          runDir,
          ['#!/bin/bash', 'set -euo pipefail', `echo 'export const b = 2;' > ${shQuote(`${clonePath}/src/b.mjs`)}`].join('\n'),
          'seed-conflicting-change.sh',
        );

        const deliveryScript = buildDeliveryScript({
          clonePath,
          motherRepoWsl: windowsToWslPath(repoRoot),
          handoffId,
          baseSha,
        });
        const deliveryExec = await runWsl(runDir, deliveryScript.scriptContent, `${deliveryScript.scriptName}-conflict`);
        expect(deliveryExec.exitCode).toBe(0);

        const delivery = parseDeliveryOutput(deliveryExec.stdout);
        expect(delivery.status).toBe('conflict');
        if (delivery.status !== 'conflict') return;
        expect(delivery.existingTree.length).toBeGreaterThan(0);
        expect(delivery.newTree.length).toBeGreaterThan(0);
        expect(delivery.existingTree).not.toBe(delivery.newTree);

        // Never a clobber: the mother's dispatch/<id> ref must still point at
        // the FIRST delivery from test 2, untouched by the rejected attempt.
        const verifyExec = await runWsl(
          runDir,
          ['#!/bin/bash', 'set -euo pipefail', `git -C ${shQuote(windowsToWslPath(repoRoot))} rev-parse refs/heads/dispatch/${handoffId}`].join('\n'),
          'verify-not-clobbered.sh',
        );
        expect(verifyExec.stdout.trim()).toBe(firstCommitSha);
      }, 60_000);
    });

    // -------------------------------------------------------------------
    // Group 2 (T17 items 6-9) — adversarial sandbox probes.
    //
    // SAFE CANARY PROBES ONLY. Every probe below either touches a harmless
    // sentinel path outside the clone bind or reads a file that is expected
    // to be unreadable -- never a destructive command. If containment ever
    // breaks, the worst outcome is a stray sentinel file, never host damage.
    // -------------------------------------------------------------------

    describe('Group 2 (T17 items 6-9): adversarial sandbox probes -- safe canary probes only, never destructive', () => {
      let runDir: string;
      let clonePath: string;

      beforeAll(async () => {
        runDir = await createTempDir('kb-canary-rundir-');
        clonePath = await createScratchDir(runDir, 'canary');
      }, 60_000);

      afterAll(async () => {
        if (clonePath) await removeScratchDir(runDir, clonePath).catch(() => undefined);
        if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      }, 60_000);

      it('6. write outside the clone (private /tmp): a canary written inside the jail never appears on the real host /tmp', async () => {
        // --tmpfs /tmp (S5 full recipe) gives the jail its OWN ephemeral /tmp
        // mount -- a write can succeed INSIDE the jail yet still never touch
        // the host's real /tmp, since the two are different mounts entirely.
        const canaryName = `canary-${randomUUID()}`;
        const jailArgv = buildJailArgs({ clonePath, unshareNet: true }).argv;
        const innerCmd = `touch /tmp/${canaryName} && echo "WROTE=/tmp/${canaryName}"`;
        const bwrapCmd = [...jailArgv, 'bash', '-c', innerCmd].map(shQuote).join(' ');

        const inJail = await runWsl(runDir, ['#!/bin/bash', bwrapCmd].join('\n'), 'canary-write-tmp.sh');
        expect(inJail.stdout).toContain(`WROTE=/tmp/${canaryName}`);

        const hostCheck = await runWsl(
          runDir,
          ['#!/bin/bash', `test -e /tmp/${canaryName} && echo EXISTS || echo ABSENT`].join('\n'),
          'canary-check-tmp.sh',
        );
        expect(hostCheck.stdout.trim()).toBe('ABSENT');
      }, 60_000);

      it('7. read /etc/shadow: real file permissions block it -- no shadow content ever reaches stdout', async () => {
        const jailArgv = buildJailArgs({ clonePath, unshareNet: true }).argv;
        const bwrapCmd = [...jailArgv, 'bash', '-c', 'cat /etc/shadow'].map(shQuote).join(' ');
        const result = await runWsl(runDir, ['#!/bin/bash', bwrapCmd].join('\n'), 'canary-read-shadow.sh');

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.trim().length).toBe(0);
        expect(result.stdout).not.toMatch(/\$[1256yb]\$/); // no crypt(3) hash prefix leaked
      }, 60_000);

      it('8. write outside any bind (read-only root): a sentinel written at / never appears on the host', async () => {
        const sentinelName = `sentinel-${randomUUID()}`;
        const jailArgv = buildJailArgs({ clonePath, unshareNet: true }).argv;
        const innerCmd = `(echo LEAKED > /${sentinelName} && echo WROTE) || echo BLOCKED`;
        const bwrapCmd = [...jailArgv, 'bash', '-c', innerCmd].map(shQuote).join(' ');

        const inJail = await runWsl(runDir, ['#!/bin/bash', bwrapCmd].join('\n'), 'canary-write-root.sh');
        expect(inJail.stdout).toContain('BLOCKED');
        expect(inJail.stdout).not.toContain('WROTE');

        const hostCheck = await runWsl(
          runDir,
          ['#!/bin/bash', `test -e /${sentinelName} && echo EXISTS || echo ABSENT`].join('\n'),
          'canary-check-root.sh',
        );
        expect(hostCheck.stdout.trim()).toBe('ABSENT');
      }, 60_000);

      it('9. network isolation: curl to an external host fails outright under --unshare-net (no network stack at all)', async () => {
        const jailArgv = buildJailArgs({ clonePath, unshareNet: true }).argv;
        const bwrapCmd = [...jailArgv, 'bash', '-c', 'curl -s -m 5 http://example.com/'].map(shQuote).join(' ');
        const result = await runWsl(runDir, ['#!/bin/bash', bwrapCmd].join('\n'), 'canary-network.sh');
        expect(result.exitCode).not.toBe(0);
      }, 60_000);
    });

    // -------------------------------------------------------------------
    // Group 3 (T17 items 10-12) — egress enforcement proofs (T26/D21).
    //
    // Reuses the REAL `buildTunnelBashLines` + `buildJailArgs` to assemble
    // the exact same forwarder/relay/jail shape pipeline.ts's own
    // buildExecutionScript wires together, substituting a plain `curl` probe
    // for the Pi worker invocation -- no model/backend config needed, only
    // bwrap+WSL2. The "granted endpoint" is a tiny self-contained Node stub
    // server (no npm deps, mirrors tunnel.ts's own style) started WSL2-side,
    // outside the jail, alongside the forwarder.
    //
    // KNOWN LIVE FAILURE (found running this suite live against a real
    // Windows+WSL2+bwrap host, 2026-09-12 -- production bug, not a test bug;
    // reported upstream, not fixed here per this task's no-source-edits
    // scope): items 10 and 11 currently fail with an empty ALLOWED_CODE/
    // DENIED_CODE because the forwarder's `server.listen(SOCKET_PATH)` throws
    // `ENOTSUP: operation not supported on socket <path under /mnt/c/...>`.
    // Root cause: `tunnel.ts`'s own module doc and s5-rulings.md ruling 1
    // both say the socket is "staged under the run dir (ext4)", but
    // pipeline.ts actually builds `tunnelSocketWsl`/`relayScriptWsl` from
    // `runDirWsl = windowsToWslPath(runDir)`, where `runDir` is
    // `getRunDir(dir, ...)` -- INSIDE the Windows-side mother repo. Converted
    // to its WSL2 form that is a DrvFS path (`/mnt/c/...`), and DrvFS does
    // not support AF_UNIX sockets at all (verified directly: an ext4 path
    // under `$HOME` binds fine, the identical call under `/mnt/c/...` throws
    // ENOTSUP every time). Every Windows-hosted mother repo hits this on
    // every `web:false` (the default) dispatch once egress enforcement is
    // actually exercised -- this is not host-specific flakiness. This test
    // mirrors pipeline.ts's actual wiring byte-for-byte on purpose (same
    // `runDirWsl` derivation for the socket/relay paths) rather than routing
    // the test's own scratch socket onto ext4 to dodge the bug -- doing that
    // would stop this suite from proving the real, currently-broken
    // integration. Item 12 (loopback-up) is unaffected (no socket involved)
    // and passes today. Fix belongs in pipeline.ts/tunnel.ts (e.g. stage the
    // socket + relay script under an ext4-backed path -- the clone path
    // already lives there -- instead of runDirWsl); once fixed, items 10/11
    // should pass unchanged.
    // -------------------------------------------------------------------

    describe('Group 3 (T17 items 10-12): egress enforcement proofs (T26/D21)', () => {
      let runDir: string;
      let runDirWsl: string;
      let clonePath: string;
      let nextStubPort = 19101;

      beforeAll(async () => {
        runDir = await createTempDir('kb-egress-rundir-');
        runDirWsl = windowsToWslPath(runDir);
        clonePath = await createScratchDir(runDir, 'egress');
      }, 60_000);

      afterAll(async () => {
        if (clonePath) await removeScratchDir(runDir, clonePath).catch(() => undefined);
        if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      }, 60_000);

      interface EgressProbeResult {
        allowedCode: string;
        allowedBody: string;
        deniedCode: string;
      }

      /**
       * One full forwarder+relay+jail round trip: starts a WSL2-side stub
       * "model endpoint", the real tunnel forwarder pointed at it
       * (web:false), and a bwrap jail with the relay bound in. Inside the
       * jail, one curl reaches the relay loopback with an ORIGIN-FORM
       * request (implicitly the granted target -- exactly how Pi's own
       * baseUrl rewrite talks to it) and one curl reaches it as an
       * HTTP-proxy request naming an ABSOLUTE, different destination (the
       * forwarder's `destinationAllowed` check denies this on web:false
       * BEFORE ever dialing out, so no real network egress to the named host
       * ever happens here).
       */
      async function runEgressProbe(): Promise<EgressProbeResult> {
        const stubPort = nextStubPort++;
        const tunnelSocketWsl = `${runDirWsl}/${TUNNEL_SOCKET_NAME}`;
        const relayScriptWsl = `${runDirWsl}/relay.js`;
        const tunnelConfig: TunnelConfig = {
          socketPath: tunnelSocketWsl,
          targetUrl: `http://127.0.0.1:${stubPort}/v1`,
          webEnabled: false,
          relayPort: TUNNEL_RELAY_PORT,
          logPath: `${runDirWsl}/tunnel-destinations.log`,
        };
        const tunnelBash = buildTunnelBashLines(tunnelConfig, runDirWsl);
        const jailArgv = buildJailArgs({
          clonePath,
          unshareNet: true,
          tunnelSocketPath: tunnelSocketWsl,
          relayScriptPath: relayScriptWsl,
        }).argv;

        const innerScript = [
          ...tunnelBash.inJailPrefix,
          `ALLOWED_CODE=$(curl -s -o /tmp/allowed-body -w '%{http_code}' http://127.0.0.1:${TUNNEL_RELAY_PORT}/v1/probe)`,
          'echo "ALLOWED_CODE=$ALLOWED_CODE"',
          'echo "ALLOWED_BODY=$(cat /tmp/allowed-body 2>/dev/null)"',
          `DENIED_CODE=$(curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:${TUNNEL_RELAY_PORT} http://example.com/)`,
          'echo "DENIED_CODE=$DENIED_CODE"',
          ...tunnelBash.inJailSuffix,
        ].join('\n');
        const bwrapCmd = [...jailArgv, 'bash', '-c', innerScript].map(shQuote).join(' ');

        const scriptContent = [
          '#!/bin/bash',
          '# Target stub -- plays the role of "the granted inference endpoint" (self-contained Node, no npm deps).',
          `node -e "require('node:http').createServer((req,res)=>res.end('MODEL_ENDPOINT_OK')).listen(${stubPort}, '127.0.0.1')" < /dev/null > /dev/null 2>&1 &`,
          'STUB_PID=$!',
          'sleep 0.3',
          '',
          ...tunnelBash.preJailLines,
          '',
          bwrapCmd,
          '',
          'kill $STUB_PID 2>/dev/null || true',
          ...tunnelBash.postJailLines,
        ].join('\n');

        const result = await runWsl(runDir, scriptContent, `egress-probe-${stubPort}.sh`, 45_000);
        return {
          allowedCode: result.stdout.match(/ALLOWED_CODE=(\d+)/)?.[1] ?? '',
          allowedBody: result.stdout.match(/ALLOWED_BODY=(\S*)/)?.[1] ?? '',
          deniedCode: result.stdout.match(/DENIED_CODE=(\d+)/)?.[1] ?? '',
        };
      }

      it('10. web:false blocks an arbitrary external destination (forwarder denies with 403 before dialing out)', async () => {
        const probe = await runEgressProbe();
        expect(probe.deniedCode).toBe('403');
      }, 60_000);

      it('11. web:false still allows the one granted model endpoint through the tunnel', async () => {
        const probe = await runEgressProbe();
        expect(probe.allowedCode).toBe('200');
        expect(probe.allowedBody).toBe('MODEL_ENDPOINT_OK');
      }, 60_000);

      it('12. loopback comes up inside a fresh --unshare-net namespace before the relay would bind (s5-rulings.md live-tier point)', async () => {
        const jailArgv = buildJailArgs({ clonePath, unshareNet: true }).argv;
        const innerScript = ['ip link set lo up 2>/dev/null || true', 'ip link show lo'].join('\n');
        const bwrapCmd = [...jailArgv, 'bash', '-c', innerScript].map(shQuote).join(' ');
        const result = await runWsl(runDir, ['#!/bin/bash', bwrapCmd].join('\n'), 'lo-up-probe.sh');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/<[^>]*\bUP\b[^>]*>/);
      }, 60_000);
    });
  },
);
