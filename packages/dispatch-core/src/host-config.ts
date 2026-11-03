/**
 * Host-local dispatch config (DEC-0046 / WK-0252 slice a). `wiki/.dispatch/`
 * tables are shared through git; the facts below are per-host, not per-repo
 * (DEC-0046 Decision 1), so they live in exactly one file under `paths.ts`'s
 * `getConfigDir()` instead — no new resolver, per DEC-0046 Decision 2.
 *
 * File: `<getConfigDir()>/host.json` (`HOST_CONFIG_FILENAME` below).
 *
 * Schema (schemaVersion 1):
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "backends": {
 *     "<backendName>": { "reachable": true, "secrets_file": "~/.secrets/dispatch.env" }
 *   },
 *   "profiles": {
 *     "<profileName>": { "<VAR_NAME>": "~/.secrets/aws.env" }
 *   }
 * }
 * ```
 *
 * Per backend: whether this host reaches it (`reachable`), and which secrets
 * file holds its key (`secrets_file`, `null` when the backend needs no key —
 * e.g. a seat-billed SaaS CLI like claude-saas is still listed, reachable:
 * true, secrets_file: null). Per profile: a map of injected variable name to
 * the secrets file holding its value. Paths only, never secret values
 * (DEC-0046 Decision 3). A leading `~` expands to the home directory here,
 * once, before any path this module returns reaches a generated bash script
 * or a direct Node `readFile` (credentials.ts / pipeline.ts).
 *
 * A missing file, a backend absent or marked unreachable, or a profile this
 * file doesn't cover are all loud refusals naming this file's path
 * (DEC-0046 Decision 4) — resolveModelFromConfig (model-registry.ts) and
 * resolveCredentials (credentials.ts) are the two call sites that enforce
 * this; this module only loads + reports coverage.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { getConfigDir } from './paths.js';

export const HOST_CONFIG_FILENAME = 'host.json';

export interface HostBackendEntry {
  reachable: boolean;
  secrets_file: string | null;
}

export interface HostConfig {
  schemaVersion: 1;
  backends: Record<string, HostBackendEntry>;
  profiles: Record<string, Record<string, string>>;
}

/** Path to the host-local dispatch config file (no new resolver — `paths.ts`'s `getConfigDir()`). */
export function getHostConfigPath(): string {
  return join(getConfigDir(), HOST_CONFIG_FILENAME);
}

/** Expand a leading `~` (bare, or `~/...`) to the home directory; any other value passes through unchanged. */
export function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateHostBackendEntry(name: string, raw: unknown, path: string): DispatchResult<HostBackendEntry> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Backend "${name}" in host config ${path} must be an object.`);
  }
  if (typeof raw.reachable !== 'boolean') {
    return fail('BAD_RECORD', `Backend "${name}" in host config ${path} must have "reachable" as a boolean.`);
  }
  if (raw.secrets_file !== null && raw.secrets_file !== undefined && typeof raw.secrets_file !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in host config ${path} must have "secrets_file" as a string or null.`);
  }
  const secretsFile = typeof raw.secrets_file === 'string' ? raw.secrets_file : null;
  return ok({
    reachable: raw.reachable,
    secrets_file: secretsFile === null ? null : expandHomePath(secretsFile),
  });
}

function validateHostProfileEntry(name: string, raw: unknown, path: string): DispatchResult<Record<string, string>> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Profile "${name}" in host config ${path} must be an object.`);
  }
  const vars: Record<string, string> = {};
  for (const [varName, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      return fail('BAD_RECORD', `Profile "${name}" variable "${varName}" in host config ${path} must be a string file path.`);
    }
    vars[varName] = expandHomePath(value);
  }
  return ok(vars);
}

/**
 * Load the host-local dispatch config. Unlike repo-config.ts's loaders, a
 * missing file is a loud refusal (`HOST_CONFIG_NOT_FOUND`) naming the path,
 * not a valid-empty table — DEC-0046 Decision 4, "no fallback to a path in
 * the repo table."
 */
export async function loadHostConfig(): Promise<DispatchResult<HostConfig>> {
  const path = getHostConfigPath();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail('HOST_CONFIG_NOT_FOUND', `Host config not found at ${path}. Create it (per backend: reachable + secrets_file; per profile: injected variable -> secrets file) before a dispatch that needs a backend or credential profile.`);
    }
    return fail('BAD_RECORD', `Failed to read host config ${path}: ${(err as Error).message}`, err);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return fail('BAD_RECORD', `Malformed JSON in host config ${path}: ${(err as Error).message}`, err);
  }

  if (!isPlainObject(data)) {
    return fail('BAD_RECORD', `Host config ${path} must be a JSON object.`);
  }
  if (data.schemaVersion !== 1) {
    return fail('BAD_RECORD', `Host config ${path} "schemaVersion" must be 1; got: ${JSON.stringify(data.schemaVersion)}`);
  }

  const backends: Record<string, HostBackendEntry> = {};
  if (data.backends !== undefined) {
    if (!isPlainObject(data.backends)) {
      return fail('BAD_RECORD', `Host config ${path} "backends" must be an object.`);
    }
    for (const [name, raw] of Object.entries(data.backends)) {
      const validated = validateHostBackendEntry(name, raw, path);
      if (!validated.ok) return validated;
      backends[name] = validated.data;
    }
  }

  const profiles: Record<string, Record<string, string>> = {};
  if (data.profiles !== undefined) {
    if (!isPlainObject(data.profiles)) {
      return fail('BAD_RECORD', `Host config ${path} "profiles" must be an object.`);
    }
    for (const [name, raw] of Object.entries(data.profiles)) {
      const validated = validateHostProfileEntry(name, raw, path);
      if (!validated.ok) return validated;
      profiles[name] = validated.data;
    }
  }

  return ok({ schemaVersion: 1, backends, profiles });
}

/**
 * Backend/profile coverage of a loaded host config against the names a
 * repo's tables reference — pure, no re-read, so slice b's check-environment
 * report (and this slice's own resolution paths) can call it without
 * duplicating the file read `loadHostConfig` already did.
 */
export interface HostConfigCoverage {
  missingBackends: string[];
  unreachableBackends: string[];
  missingProfiles: string[];
}

export function computeHostConfigCoverage(
  hostConfig: HostConfig,
  backendNames: readonly string[],
  profileNames: readonly string[],
): HostConfigCoverage {
  const missingBackends: string[] = [];
  const unreachableBackends: string[] = [];
  for (const name of backendNames) {
    const entry = hostConfig.backends[name];
    if (!entry) missingBackends.push(name);
    else if (!entry.reachable) unreachableBackends.push(name);
  }
  const missingProfiles = profileNames.filter((name) => !hostConfig.profiles[name]);
  return { missingBackends, unreachableBackends, missingProfiles };
}
