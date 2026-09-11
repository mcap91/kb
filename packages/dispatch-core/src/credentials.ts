/**
 * §7.6/T10/T12 credential resolution (dispatch v2, PLN-0004 S3 Wave 2a). Pure
 * module: resolves HO `credentials:` profile names against the repo-local
 * `wiki/.dispatch/profiles.json` config (repo-config.ts), enforces the
 * credentials+web hard stop and the `vars` collision policy, and builds the
 * bash fragments the generated execution script needs for script-side
 * selective injection.
 *
 * Selective injection is SCRIPT-SIDE (Linux), not launcher-side (s3-rulings.md
 * freeze correction): secret values exist only Linux-side, never in Windows
 * process memory or in generated script text. Every fragment this module
 * builds reads a value from its named file IN-SHELL at run time; this module
 * itself never reads a credential file and never embeds a resolved value in
 * its output — only var names and file paths, which are not secret.
 *
 * No I/O here, and no preflight probing (S3 ruling 3: kb never executes
 * credential commands). File-existence checking is a script-side concern
 * (`existenceCheckLines`, run pre-spawn as a preflight fragment), not a
 * Node-side check performed by `resolveCredentials`. Wave 3 (`pipeline.ts`)
 * is the only caller that wires this module's output into the generated
 * script and the synchronous admission gate.
 */
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import type { Handoff } from './ho.js';
import type { ProfilesConfig, ProfileEntry, BackendEntry } from './repo-config.js';

export interface CredentialResolution {
  /** Profile names that were granted (names only, never values). */
  granted: string[];
  /** Per-profile inject var names → file paths (for script-side injection). */
  injections: Array<{ profileName: string; varName: string; filePath: string }>;
  /** The resolved backend's api_key_env (if any) — also injected script-side. */
  backendApiKeyEnv: string | null;
  backendSecretsFile: string | null;
}

export interface InjectionScriptLines {
  /** Lines for the generated bash script that export injected vars by reading their files. */
  exportLines: string[];
  /** Lines for HO `vars` (non-secret literal env). */
  varsExportLines: string[];
  /** Lines for the Linux-side existence-check fragment (checked pre-spawn). */
  existenceCheckLines: string[];
}

/** Single-quote a value for safe embedding in generated bash (escapes embedded quotes). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Split a "KEY=value" HO `vars` entry on its first `=`; malformed entries (no `=`, or a leading `=`) are dropped. */
function parseVarEntry(entry: string): { key: string; value: string } | null {
  const idx = entry.indexOf('=');
  if (idx <= 0) return null;
  return { key: entry.substring(0, idx), value: entry.substring(idx + 1) };
}

/**
 * Resolve each HO `credentials:` profile name against `profilesConfig`,
 * failing closed on the first name not present there (`UNKNOWN_PROFILE`).
 * Pure/sync: whether an `inject` file actually exists/holds its var is a
 * script-side check (`buildInjectionScript`'s `existenceCheckLines`), not
 * verified here — this function only collects what a valid profile
 * reference implies. The backend's `api_key_env`/`secrets_file` pass straight
 * through for script-side injection alongside the granted profiles — model
 * keys are backend-owned infrastructure, never gated by `credentials:`
 * (s3-rulings.md ruling 2).
 */
export function resolveCredentials(
  handoff: Handoff,
  profilesConfig: ProfilesConfig,
  backend: BackendEntry,
): DispatchResult<CredentialResolution> {
  const granted: string[] = [];
  const injections: CredentialResolution['injections'] = [];

  for (const profileName of handoff.credentials) {
    const profile: ProfileEntry | undefined = profilesConfig.profiles[profileName];
    if (!profile) {
      return fail(
        'UNKNOWN_PROFILE',
        `Handoff ${handoff.id} names unknown credential profile "${profileName}" (not present in profiles.json).`,
      );
    }

    granted.push(profileName);
    for (const [varName, filePath] of Object.entries(profile.inject)) {
      injections.push({ profileName, varName, filePath });
    }
  }

  return ok({
    granted,
    injections,
    backendApiKeyEnv: backend.api_key_env,
    backendSecretsFile: backend.secrets_file,
  });
}

/**
 * Two policy checks over an already-resolved `CredentialResolution`, run in
 * order and failing on the first violation:
 *
 * 1. `CREDENTIALS_WITH_WEB` (spec §7.6) — `credentials:` and `web: true` are
 *    mutually exclusive: a worker must never hold both a live secret and open
 *    network access in the same run.
 * 2. Vars collision — HO `vars` is non-secret literal env (D8); a `vars` key
 *    that collides with an injected profile var or the backend's
 *    `api_key_env` would let the HO author silently shadow or masquerade as a
 *    credential value through a non-secret channel, so it refuses instead.
 */
export function checkCredentialPolicy(handoff: Handoff, resolution: CredentialResolution): DispatchResult<void> {
  if (handoff.credentials.length > 0 && handoff.web === true) {
    return fail('CREDENTIALS_WITH_WEB', 'Credentials and web access cannot be combined (spec §7.6).');
  }

  const injectedVarNames = new Set(resolution.injections.map((injection) => injection.varName));
  if (resolution.backendApiKeyEnv) {
    injectedVarNames.add(resolution.backendApiKeyEnv);
  }

  for (const entry of handoff.vars) {
    const parsed = parseVarEntry(entry);
    if (!parsed) continue;
    if (injectedVarNames.has(parsed.key)) {
      return fail('BAD_RECORD', `HO vars key "${parsed.key}" collides with injected credential var "${parsed.key}".`);
    }
  }

  return ok(undefined);
}

/**
 * Build the three bash-fragment sets the generated execution script needs
 * for script-side selective injection. `exportLines` and `existenceCheckLines`
 * read values from their named files IN-SHELL; neither this function nor its
 * output ever carries a resolved credential value.
 */
export function buildInjectionScript(resolution: CredentialResolution, handoffVars: string[]): InjectionScriptLines {
  const exportLines: string[] = [];
  for (const injection of resolution.injections) {
    exportLines.push(
      `export ${injection.varName}="$(grep -m1 '^${injection.varName}=' ${shQuote(injection.filePath)} | cut -d= -f2-)"`,
    );
  }
  if (resolution.backendApiKeyEnv && resolution.backendSecretsFile) {
    exportLines.push(
      `export ${resolution.backendApiKeyEnv}="$(grep -m1 '^${resolution.backendApiKeyEnv}=' ${shQuote(resolution.backendSecretsFile)} | cut -d= -f2-)"`,
    );
  }

  const varsExportLines: string[] = [];
  for (const entry of handoffVars) {
    const parsed = parseVarEntry(entry);
    if (!parsed) continue;
    varsExportLines.push(`export ${parsed.key}=${shQuote(parsed.value)}`);
  }

  const existenceCheckLines: string[] = [];
  for (const injection of resolution.injections) {
    existenceCheckLines.push(
      `if ! grep -q '^${injection.varName}=' ${shQuote(injection.filePath)}; then echo "CREDENTIAL_NOT_CONFIGURED:${injection.varName}"; exit 1; fi`,
    );
  }

  return { exportLines, varsExportLines, existenceCheckLines };
}

/**
 * Build the enumerate script's injected-value scan fragment (s3-rulings.md
 * freeze correction): boolean `SECRET_HIT=<VAR_NAME>` hits only, names never
 * values. Spliced into the WSL2-side enumerate script by Wave 3, which
 * defines `$DIFF_FILE`. Scoped to profile `inject` values only, the same
 * scope as `existenceCheckLines` — the backend API key is backend-owned
 * infrastructure (ruling 2) rather than a `credentials:`-gated value, and
 * pattern scanning (delivery.ts `scanSecrets`) already covers common API key
 * shapes.
 */
export function buildInjectedValueScanFragment(resolution: CredentialResolution): string[] {
  const lines: string[] = [];
  for (const injection of resolution.injections) {
    lines.push(
      `_VAL="$(grep -m1 '^${injection.varName}=' ${shQuote(injection.filePath)} | cut -d= -f2-)"`,
      `if [ -n "$_VAL" ] && grep -qF "$_VAL" "$DIFF_FILE"; then echo "SECRET_HIT=${injection.varName}"; fi`,
    );
  }
  return lines;
}

/**
 * Parse `SECRET_HIT=<VAR_NAME>` lines out of the combined stdout of whatever
 * script `buildInjectedValueScanFragment`'s lines were spliced into (mirrors
 * `model-registry.ts`'s `buildFingerprintFragment`/`parseFingerprintOutput`
 * build+parse pairing). Names only, in the order emitted — never values
 * (s3-rulings.md freeze correction: the resolved secret values are grepped
 * entirely Linux-side and never cross back into this TS-side result).
 */
export function parseInjectedValueScanOutput(stdout: string): string[] {
  return stdout
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('SECRET_HIT='))
    .map((line) => line.slice('SECRET_HIT='.length).trim());
}
