/**
 * Loaders + strict validation for the three repo-local `wiki/.dispatch/` config
 * tables (PLN-0004 S3 ruling 1/5): `models.json`, `backends.json`, `profiles.json`.
 * All three are valid-empty when absent or when the whole `wiki/.dispatch/`
 * directory is missing — `init-dispatch` (S3 wave 3) scaffolds them, but dispatch
 * must not refuse a repo merely because that scaffold hasn't been run yet.
 * Malformed models/backends JSON is a loud refusal naming the file + parse error
 * (ruling 1); malformed profiles.json is refused HERE too — it is the caller's
 * job (credentials.ts, S3 wave 2) to only enforce that refusal for credentialed
 * dispatches, per ruling 1's "malformed profiles.json refuses credentialed
 * dispatches only".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

/** Which agent CLI adapter handles a backend: Pi coding agent, Codex CLI, or Claude Code CLI. */
export type BackendFamily = 'pi' | 'codex' | 'claude';

/**
 * Per-family effort/reasoning-level CLI mapping (WK-0122). The mapping IS the
 * capability declaration — a backend with no `effort_mapping` does not
 * support effort, full stop; there is no separate boolean flag to keep in
 * sync. `flag_value` splices `<flag> <level>` (Claude: `--effort high`);
 * `key_equals_value` splices `<flag> <key>=<level>` (Codex: `-c
 * model_reasoning_effort=high`).
 */
export interface EffortMapping {
  flag: string;
  style: 'flag_value' | 'key_equals_value';
  key?: string;
}

export interface BackendEntry {
  family: BackendFamily;
  /** Custom endpoint URL; null when the family's own CLI reaches its SaaS provider directly (no operator-configured endpoint). */
  base_url: string | null;
  api_key_env: string | null;
  secrets_file: string | null;
  notes?: string;
  serving?: {
    context_window?: number;
    [key: string]: unknown;
  };
  /** Optional per-family effort/reasoning CLI mapping (WK-0122). Absent = effort not supported for this backend. */
  effort_mapping?: EffortMapping;
}

export interface ModelTableEntry {
  available_on: string[];
  model_id: string;
  notes?: string;
  inference?: Record<string, unknown>;
  tool_call_parser?: string;
}

export interface ProfileEntry {
  /** VAR_NAME -> file path holding that var's value (read Linux-side only; S3 wave 2). */
  inject: Record<string, string>;
  /** Endpoint hostnames this credential grants access to (exact + *.suffix wildcards).
   *  Appended to the forwarder's allowed destinations when this profile is granted
   *  (DEC-0011/WK-0104). */
  endpoints?: string[];
}

export interface ProfilesConfig {
  schemaVersion: number;
  profiles: Record<string, ProfileEntry>;
}

export interface RepoDispatchConfig {
  models: Record<string, ModelTableEntry>;
  backends: Record<string, BackendEntry>;
  profiles: ProfilesConfig;
}

function dispatchConfigPath(dir: string, filename: string): string {
  return join(dir, 'wiki', '.dispatch', filename);
}

/**
 * Read + JSON.parse a `wiki/.dispatch/` table. `data: undefined` means the file
 * is absent (ENOENT) — a valid state, not a failure. Any other read error, or a
 * JSON syntax error, is a `BAD_RECORD` refusal naming the file.
 */
async function loadJsonFile(path: string, filename: string): Promise<DispatchResult<unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(undefined);
    }
    return fail('BAD_RECORD', `Failed to read ${filename}: ${(err as Error).message}`, err);
  }

  try {
    return ok(JSON.parse(text) as unknown);
  } catch (err) {
    return fail('BAD_RECORD', `Malformed JSON in ${filename}: ${(err as Error).message}`, err);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(entry: Record<string, unknown>, knownKeys: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(entry)) {
    if (!knownKeys.has(key)) {
      console.warn(`Warning: unknown key "${key}" in ${context}`);
    }
  }
}

const BACKEND_ENTRY_KNOWN_KEYS = new Set(['family', 'base_url', 'api_key_env', 'secrets_file', 'notes', 'serving', 'effort_mapping']);

const EFFORT_MAPPING_STYLES: readonly EffortMapping['style'][] = ['flag_value', 'key_equals_value'];

const BACKEND_FAMILIES: readonly BackendFamily[] = ['pi', 'codex', 'claude'];

function validateBackendEntry(name: string, raw: unknown): DispatchResult<BackendEntry> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must be an object.`);
  }

  warnUnknownKeys(raw, BACKEND_ENTRY_KNOWN_KEYS, `backend "${name}" in backends.json`);

  if (typeof raw.family !== 'string' || !BACKEND_FAMILIES.includes(raw.family as BackendFamily)) {
    return fail(
      'BAD_RECORD',
      `Backend "${name}" in backends.json must have "family" as one of: ${BACKEND_FAMILIES.join(', ')}.`,
    );
  }
  if (raw.base_url !== null && typeof raw.base_url !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must have "base_url" as a string or null.`);
  }
  if (raw.api_key_env !== null && typeof raw.api_key_env !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must have "api_key_env" as a string or null.`);
  }
  if (raw.secrets_file !== null && typeof raw.secrets_file !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must have "secrets_file" as a string or null.`);
  }

  if (raw.serving !== undefined) {
    if (!isPlainObject(raw.serving)) {
      return fail('BAD_RECORD', `Backend "${name}" in backends.json: "serving" must be an object.`);
    }
    if (raw.serving.context_window !== undefined && typeof raw.serving.context_window !== 'number') {
      return fail('BAD_RECORD', `Backend "${name}" in backends.json: "serving.context_window" must be a number when present.`);
    }
  }

  let effortMapping: EffortMapping | undefined;
  if (raw.effort_mapping !== undefined) {
    if (!isPlainObject(raw.effort_mapping)) {
      return fail('BAD_RECORD', `Backend "${name}" in backends.json: "effort_mapping" must be an object.`);
    }
    const { flag, style, key } = raw.effort_mapping;
    if (typeof flag !== 'string' || flag.length === 0) {
      return fail('BAD_RECORD', `Backend "${name}" in backends.json: "effort_mapping.flag" must be a non-empty string.`);
    }
    if (typeof style !== 'string' || !EFFORT_MAPPING_STYLES.includes(style as EffortMapping['style'])) {
      return fail(
        'BAD_RECORD',
        `Backend "${name}" in backends.json: "effort_mapping.style" must be one of: ${EFFORT_MAPPING_STYLES.join(', ')}.`,
      );
    }
    if (key !== undefined && typeof key !== 'string') {
      return fail('BAD_RECORD', `Backend "${name}" in backends.json: "effort_mapping.key" must be a string when present.`);
    }
    if (style === 'key_equals_value' && (typeof key !== 'string' || key.length === 0)) {
      return fail(
        'BAD_RECORD',
        `Backend "${name}" in backends.json: "effort_mapping.key" is required (non-empty string) when "effort_mapping.style" is "key_equals_value".`,
      );
    }
    effortMapping = { flag, style: style as EffortMapping['style'], ...(key !== undefined ? { key } : {}) };
  }

  const entry: BackendEntry = {
    family: raw.family as BackendFamily,
    base_url: raw.base_url as string | null,
    api_key_env: raw.api_key_env as string | null,
    secrets_file: raw.secrets_file as string | null,
  };
  if (typeof raw.notes === 'string') entry.notes = raw.notes;
  if (isPlainObject(raw.serving)) {
    const serving: BackendEntry['serving'] = {};
    if (typeof raw.serving.context_window === 'number') serving.context_window = raw.serving.context_window;
    for (const [k, v] of Object.entries(raw.serving)) {
      if (k !== 'context_window') serving[k] = v;
    }
    entry.serving = serving;
  }
  if (effortMapping) entry.effort_mapping = effortMapping;
  return ok(entry);
}

const MODEL_TABLE_ENTRY_KNOWN_KEYS = new Set(['available_on', 'model_id', 'notes', 'inference', 'tool_call_parser']);

function validateModelTableEntry(slug: string, raw: unknown): DispatchResult<ModelTableEntry> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Model "${slug}" in models.json must be an object.`);
  }

  warnUnknownKeys(raw, MODEL_TABLE_ENTRY_KNOWN_KEYS, `model "${slug}" in models.json`);

  if (!Array.isArray(raw.available_on) || !raw.available_on.every((entry) => typeof entry === 'string')) {
    return fail('BAD_RECORD', `Model "${slug}" in models.json must have "available_on" as an array of strings.`);
  }
  if (typeof raw.model_id !== 'string') {
    return fail('BAD_RECORD', `Model "${slug}" in models.json must have a string "model_id".`);
  }
  if (raw.inference !== undefined && !isPlainObject(raw.inference)) {
    return fail('BAD_RECORD', `Model "${slug}" in models.json: "inference" must be an object when present.`);
  }
  if (raw.tool_call_parser !== undefined) {
    if (typeof raw.tool_call_parser !== 'string' || raw.tool_call_parser.trim() === '') {
      return fail('BAD_RECORD', `Model "${slug}" in models.json: "tool_call_parser" must be a non-empty string when present.`);
    }
  }

  const entry: ModelTableEntry = {
    available_on: raw.available_on as string[],
    model_id: raw.model_id,
  };
  if (typeof raw.notes === 'string') entry.notes = raw.notes;
  if (isPlainObject(raw.inference)) entry.inference = raw.inference as Record<string, unknown>;
  if (typeof raw.tool_call_parser === 'string') entry.tool_call_parser = raw.tool_call_parser;
  return ok(entry);
}

function validateProfileEntry(name: string, raw: unknown): DispatchResult<ProfileEntry> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Profile "${name}" in profiles.json must be an object.`);
  }

  // Strict, unlike backends/models above: profiles.json IS the credential policy
  // (D8) and an unrecognized key here could silently fail to gate what it looks
  // like it gates, so this refuses instead of warning.
  for (const key of Object.keys(raw)) {
    if (key !== 'inject' && key !== 'endpoints') {
      return fail('BAD_RECORD', `Unknown key "${key}" in profile "${name}" in profiles.json`);
    }
  }

  if (!isPlainObject(raw.inject)) {
    return fail('BAD_RECORD', `Profile "${name}" in profiles.json must have an "inject" object.`);
  }

  const inject: Record<string, string> = {};
  for (const [varName, value] of Object.entries(raw.inject)) {
    if (typeof value !== 'string') {
      return fail('BAD_RECORD', `Profile "${name}" in profiles.json: inject["${varName}"] must be a string file path.`);
    }
    inject[varName] = value;
  }

  const profileEntry: ProfileEntry = { inject };

  if (raw.endpoints !== undefined) {
    if (!Array.isArray(raw.endpoints) || !raw.endpoints.every((host) => typeof host === 'string')) {
      return fail('BAD_RECORD', `Profile "${name}" in profiles.json: "endpoints" must be an array of strings when present.`);
    }
    profileEntry.endpoints = raw.endpoints as string[];
  }

  return ok(profileEntry);
}

/**
 * Load `wiki/.dispatch/models.json` (slug -> available_on/model_id/notes).
 * Absent file = valid empty table.
 */
export async function loadModelsTable(dir: string): Promise<DispatchResult<Record<string, ModelTableEntry>>> {
  const loaded = await loadJsonFile(dispatchConfigPath(dir, 'models.json'), 'models.json');
  if (!loaded.ok) return loaded;
  if (loaded.data === undefined) return ok({});

  if (!isPlainObject(loaded.data)) {
    return fail('BAD_RECORD', 'models.json must be a JSON object mapping model slug to entry.');
  }

  const table: Record<string, ModelTableEntry> = {};
  for (const [slug, rawEntry] of Object.entries(loaded.data)) {
    const validated = validateModelTableEntry(slug, rawEntry);
    if (!validated.ok) return validated;
    table[slug] = validated.data;
  }
  return ok(table);
}

/**
 * Load `wiki/.dispatch/backends.json` (name -> family/base_url/api_key_env/secrets_file/notes).
 * Absent file = valid empty table.
 */
export async function loadBackendsTable(dir: string): Promise<DispatchResult<Record<string, BackendEntry>>> {
  const loaded = await loadJsonFile(dispatchConfigPath(dir, 'backends.json'), 'backends.json');
  if (!loaded.ok) return loaded;
  if (loaded.data === undefined) return ok({});

  if (!isPlainObject(loaded.data)) {
    return fail('BAD_RECORD', 'backends.json must be a JSON object mapping backend name to entry.');
  }

  const table: Record<string, BackendEntry> = {};
  for (const [name, rawEntry] of Object.entries(loaded.data)) {
    const validated = validateBackendEntry(name, rawEntry);
    if (!validated.ok) return validated;
    table[name] = validated.data;
  }
  return ok(table);
}

/**
 * Load `wiki/.dispatch/profiles.json` (schema_version 1 + named `inject` profiles).
 * Absent file = valid empty config at schema_version 1.
 */
export async function loadProfilesConfig(dir: string): Promise<DispatchResult<ProfilesConfig>> {
  const loaded = await loadJsonFile(dispatchConfigPath(dir, 'profiles.json'), 'profiles.json');
  if (!loaded.ok) return loaded;
  if (loaded.data === undefined) return ok({ schemaVersion: 1, profiles: {} });

  if (!isPlainObject(loaded.data)) {
    return fail('BAD_RECORD', 'profiles.json must be a JSON object.');
  }

  const { schema_version: schemaVersion, ...profileEntries } = loaded.data;
  if (schemaVersion !== 1) {
    return fail('BAD_RECORD', `profiles.json "schema_version" must be 1; got: ${JSON.stringify(schemaVersion)}`);
  }

  const profiles: Record<string, ProfileEntry> = {};
  for (const [name, rawEntry] of Object.entries(profileEntries)) {
    const validated = validateProfileEntry(name, rawEntry);
    if (!validated.ok) return validated;
    profiles[name] = validated.data;
  }

  return ok({ schemaVersion: 1, profiles });
}
