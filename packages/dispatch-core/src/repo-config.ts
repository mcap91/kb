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

export interface BackendEntry {
  base_url: string;
  api_key_env: string | null;
  secrets_file: string | null;
  notes?: string;
}

export interface ModelTableEntry {
  available_on: string[];
  model_id: string;
  notes?: string;
  /** §7.13 context-budget gate input (tokens); model-registry.ts defaults when absent. */
  context_window?: number;
}

export interface ProfileEntry {
  /** VAR_NAME -> file path holding that var's value (read Linux-side only; S3 wave 2). */
  inject: Record<string, string>;
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

const BACKEND_ENTRY_KNOWN_KEYS = new Set(['base_url', 'api_key_env', 'secrets_file', 'notes']);

function validateBackendEntry(name: string, raw: unknown): DispatchResult<BackendEntry> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must be an object.`);
  }

  warnUnknownKeys(raw, BACKEND_ENTRY_KNOWN_KEYS, `backend "${name}" in backends.json`);

  if (typeof raw.base_url !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must have a string "base_url".`);
  }
  if (raw.api_key_env !== null && typeof raw.api_key_env !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must have "api_key_env" as a string or null.`);
  }
  if (raw.secrets_file !== null && typeof raw.secrets_file !== 'string') {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must have "secrets_file" as a string or null.`);
  }

  const entry: BackendEntry = {
    base_url: raw.base_url,
    api_key_env: raw.api_key_env as string | null,
    secrets_file: raw.secrets_file as string | null,
  };
  if (typeof raw.notes === 'string') entry.notes = raw.notes;
  return ok(entry);
}

const MODEL_TABLE_ENTRY_KNOWN_KEYS = new Set(['available_on', 'model_id', 'notes', 'context_window']);

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
  if (raw.context_window !== undefined && typeof raw.context_window !== 'number') {
    return fail('BAD_RECORD', `Model "${slug}" in models.json must have "context_window" as a number when present.`);
  }

  const entry: ModelTableEntry = {
    available_on: raw.available_on as string[],
    model_id: raw.model_id,
  };
  if (typeof raw.notes === 'string') entry.notes = raw.notes;
  if (typeof raw.context_window === 'number') entry.context_window = raw.context_window;
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
    if (key !== 'inject') {
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

  return ok({ inject });
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
 * Load `wiki/.dispatch/backends.json` (name -> base_url/api_key_env/secrets_file/notes).
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
