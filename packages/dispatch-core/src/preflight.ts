/**
 * §7/T27 host-setup preflight + remediation (dispatch v2, PLN-0004 S0 Wave 3;
 * DEC-0008 D20). A stock Ubuntu 24.04+ host ships
 * `kernel.apparmor_restrict_unprivileged_userns=1`, which silently blocks
 * unprivileged bwrap user namespaces out of the box — a launch-blocker for the
 * bwrap-direct/bwrap-via-WSL2 tiers, not a footnote. This module probes bwrap
 * presence, runs a LIVE `bwrap --unshare-user` round trip (the sysctl value
 * alone is not proof — some hosts carry the restriction without the sysctl
 * present, and vice versa), and reads the sysctl for diagnostic completeness.
 *
 * kb never runs `sudo` itself. A refusal only ever PRINTS the exact
 * remediation (the `/etc/apparmor.d/bwrap` userns profile + `systemctl reload
 * apparmor`) for the operator to run once per host, then re-run preflight.
 */
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { execViaWsl2 } from './wsl2.js';

export interface PreflightResult {
  bwrapAvailable: boolean;
  unshareUserWorks: boolean;
  appArmorRestriction: boolean;
  remediationNeeded: boolean;
  remediationText?: string;
}

/**
 * The T27 probe script: bwrap presence + version, a live `--unshare-user`
 * round trip, and the Ubuntu 24.04+ AppArmor userns sysctl. Every command is
 * self-guarded (`|| echo MISSING`, the `if`/`else`) so the script always runs
 * to completion and exits 0 regardless of what it finds — a non-zero exit
 * from `execViaWsl2` means the SCRIPT itself failed to run, not that a
 * capability was found missing (that's reported as data, not a failure).
 */
const PREFLIGHT_SCRIPT = [
  '#!/bin/bash',
  'echo "BWRAP_PATH=$(which bwrap 2>/dev/null || echo MISSING)"',
  'echo "BWRAP_VERSION=$(bwrap --version 2>/dev/null || echo MISSING)"',
  '',
  '# Live unshare-user probe',
  'if bwrap --unshare-user --ro-bind / / true 2>/dev/null; then',
  '  echo "UNSHARE_USER=OK"',
  'else',
  '  echo "UNSHARE_USER=FAIL"',
  'fi',
  '',
  '# AppArmor userns restriction check (Ubuntu 24.04+)',
  'SYSCTL_VAL=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo "N/A")',
  'echo "APPARMOR_USERNS=$SYSCTL_VAL"',
  '',
].join('\n');

/** kb-authored remediation text (DEC-0008 D20). kb never runs sudo itself — this is printed, never executed. */
const REMEDIATION_TEXT = `bwrap user namespace support is required but blocked.

If running Ubuntu 24.04+, the AppArmor restriction on unprivileged user namespaces
must be relaxed for bwrap. Create this profile and reload:

  sudo tee /etc/apparmor.d/bwrap <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE

  sudo systemctl reload apparmor

Then re-run the preflight check.`;

function getFieldValue(lines: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const line = lines.find((l) => l.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length).trim();
}

/**
 * Parse the T27 probe script's stdout into a `PreflightResult`. Pure and
 * exported so the parsing logic is unit-testable without a live WSL2/bwrap
 * host (mirrors wsl2.ts's `classifySignalExit` split: live exec vs. pure
 * parse). `remediationNeeded` is true when bwrap is missing OR the live
 * unshare-user probe failed — the sysctl reading (`appArmorRestriction`) is
 * carried as a diagnostic fact only, since a host can fail unshare-user for
 * reasons other than this one sysctl (and the sysctl can be set without
 * actually blocking a given bwrap build).
 */
export function parsePreflightOutput(stdout: string): PreflightResult {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');

  const bwrapPath = getFieldValue(lines, 'BWRAP_PATH');
  const unshareUser = getFieldValue(lines, 'UNSHARE_USER');
  const apparmorUserns = getFieldValue(lines, 'APPARMOR_USERNS');

  const bwrapAvailable = bwrapPath !== undefined && bwrapPath !== '' && bwrapPath !== 'MISSING';
  const unshareUserWorks = unshareUser === 'OK';
  const appArmorRestriction = apparmorUserns === '1';
  const remediationNeeded = !bwrapAvailable || !unshareUserWorks;

  return {
    bwrapAvailable,
    unshareUserWorks,
    appArmorRestriction,
    remediationNeeded,
    ...(remediationNeeded ? { remediationText: REMEDIATION_TEXT } : {}),
  };
}

/**
 * Run the T27 host preflight inside WSL2 (bwrap presence, a live
 * `--unshare-user` round trip, the AppArmor userns sysctl). Stages and
 * executes the probe script via `execViaWsl2` — kb never runs `sudo` itself;
 * a blocked host is reported as data (`remediationNeeded` + `remediationText`),
 * never thrown, so the caller (pipeline.ts) decides whether to refuse the run.
 */
export async function runPreflight(runDir: string): Promise<DispatchResult<PreflightResult>> {
  const execResult = await execViaWsl2({
    runDir,
    scriptContent: PREFLIGHT_SCRIPT,
    scriptName: 'dispatch-preflight.sh',
  });
  if (!execResult.ok) return execResult;

  if (execResult.data.exitCode !== 0) {
    return fail(
      'PREFLIGHT_FAILED',
      `Preflight script exited with code ${execResult.data.exitCode}; expected 0 (every probe in the script is self-guarded).`,
      execResult.data,
    );
  }

  return ok(parsePreflightOutput(execResult.data.stdout));
}
