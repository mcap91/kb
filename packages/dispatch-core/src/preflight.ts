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
import { execBash } from './exec-direct.js';

export interface PreflightResult {
  bwrapAvailable: boolean;
  unshareUserWorks: boolean;
  appArmorRestriction: boolean;
  remediationNeeded: boolean;
  remediationText?: string;
  /** Pi harness version (`pi --version`), for the S3 ruling-7 version gate. Absent when the probe reported MISSING. */
  piVersion?: string;
  /**
   * Host git version (`git --version`), the first `<major>.<minor>[.<patch>]`
   * found — so distro suffixes (`2.43.0.windows.1`) parse. Absent when the
   * probe reported MISSING or carried no parseable version. Carried as its
   * own fact, never folded into `remediationNeeded` (whose text is the
   * bwrap/AppArmor remediation); `gateGitVersion` is the separate gate.
   */
  gitVersion?: string;
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
  '',
  '# Non-interactive shells skip .bashrc; ensure npm-global and local bins are reachable',
  'export PATH="$HOME/.npm-global-wsl/bin:$HOME/.local/bin:$PATH"',
  '',
  'echo "BWRAP_PATH=$(which bwrap 2>/dev/null || echo MISSING)"',
  'echo "BWRAP_VERSION=$(bwrap --version 2>/dev/null || echo MISSING)"',
  // Rides the existing preflight script rather than a dedicated probe (S3 ruling 7) — same KEY=value convention, one fewer WSL2 round trip.
  'echo "PI_VERSION=$(pi --version 2>/dev/null || echo MISSING)"',
  // Same convention for the host git floor; delivery's
  // --attr-source option needs git >= 2.41, so preflight reports the version.
  'echo "GIT_VERSION=$(git --version 2>/dev/null || echo MISSING)"',
  '',
  '# Live unshare-user probe — mirrors the curated SYSTEM_ROOTS jail dispatch',
  '# actually builds (jail.ts:131-133), not a whole-root bind (SRC-0013, WK-0174).',
  'if bwrap --unshare-user \\',
  '  --ro-bind-try /usr /usr --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \\',
  '  --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind-try /etc /etc \\',
  '  --ro-bind-try /opt /opt --ro-bind-try /var /var \\',
  '  --proc /proc --dev /dev true 2>/dev/null; then',
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
 * Extract the first `<major>.<minor>[.<patch>]` from a `git --version` value.
 * `git --version` prints `git version 2.43.0`, but distro/vendor builds append
 * a suffix (`2.43.0.windows.1`, `2.39.3 (Apple Git-145)`); the numeric core is
 * the only part the version gate can compare. `undefined` when MISSING or no
 * numeric version is present.
 */
function parseGitVersion(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === 'MISSING') return undefined;
  const match = raw.match(/\d+\.\d+(?:\.\d+)?/);
  return match?.[0];
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
  const piVersion = getFieldValue(lines, 'PI_VERSION');
  const gitVersion = parseGitVersion(getFieldValue(lines, 'GIT_VERSION'));

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
    ...(piVersion !== undefined && piVersion !== 'MISSING' ? { piVersion } : {}),
    ...(gitVersion !== undefined ? { gitVersion } : {}),
  };
}

/** Host git floor for delivery's `--attr-source` pin, added in git 2.41. */
export const MIN_GIT_VERSION = { major: 2, minor: 41 } as const;

/**
 * Refuse-below gate for the host git version. Returns the `PREFLIGHT_FAILED`
 * message, or null when the version is at or above the floor. A missing or
 * unparseable version (the probe's value was `MISSING` or carried no numeric
 * core) fails closed naming "none": the delivery path's `--attr-source`
 * option is only trustworthy on a git known to be new enough. Major and minor
 * are compared as numbers.
 */
export function gateGitVersion(gitVersion: string | undefined): string | null {
  if (gitVersion === undefined) {
    return `Preflight found git version none; git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or later required.`;
  }
  const [major, minor] = gitVersion.split('.').map((part) => Number(part));
  if (major < MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor < MIN_GIT_VERSION.minor)) {
    return `Preflight found git version ${gitVersion}; git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or later required.`;
  }
  return null;
}

/**
 * Run the T27 host preflight (bwrap presence, a live `--unshare-user` round
 * trip, the AppArmor userns sysctl). Runs the probe script directly via
 * `execBash` (D6 Phase 2 — no more script-file staging, no more `wsl.exe`
 * boundary to cross) — kb never runs `sudo` itself; a blocked host is
 * reported as data (`remediationNeeded` + `remediationText`), never thrown,
 * so the caller (pipeline.ts) decides whether to refuse the run.
 */
export async function runPreflight(): Promise<DispatchResult<PreflightResult>> {
  const execResult = await execBash({ scriptContent: PREFLIGHT_SCRIPT });
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
