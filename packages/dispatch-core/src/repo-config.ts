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
  notes?: string;
  serving?: {
    context_window?: number;
    [key: string]: unknown;
  };
  /** Optional per-family effort/reasoning CLI mapping (WK-0122). Absent = effort not supported for this backend. */
  effort_mapping?: EffortMapping;
  request_params?: Record<string, unknown>;
  /**
   * Cost model for this backend (WK-0123): `api` backends have true
   * per-token cost; `seat` backends (Claude Max, ChatGPT Pro) are flat-rate
   * subscriptions with no per-token API cost. Absent defaults to `api` — no
   * existing backends.json entry needs to be updated for this field to work.
   */
  billing?: 'seat' | 'api';
}

export interface ModelTableEntry {
  available_on: string[];
  model_id: string;
  notes?: string;
  inference?: Record<string, unknown>;
  tool_call_parser?: string;
  /** HO modes (implement/code_review/redteam/research) this model is a default for (WK-0070). Absent = no default mode. */
  use_for?: string[];
  /** Per-turn output budget (tokens) for the pi-family worker (WK-0205). Absent = model-registry.ts's DEFAULT_MAX_TOKENS. Must be a positive integer below the resolved context window. */
  max_tokens?: number;
}

export interface ProfileEntry {
  /** Variable names this profile injects (DEC-0046: the secrets file for each is a host fact, resolved from host-config.ts's HostConfig, never this repo table). */
  inject: string[];
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

const BACKEND_ENTRY_KNOWN_KEYS = new Set(['family', 'base_url', 'api_key_env', 'notes', 'serving', 'effort_mapping', 'request_params', 'billing']);

const EFFORT_MAPPING_STYLES: readonly EffortMapping['style'][] = ['flag_value', 'key_equals_value'];

const BACKEND_FAMILIES: readonly BackendFamily[] = ['pi', 'codex', 'claude'];

const BILLING_KINDS: readonly NonNullable<BackendEntry['billing']>[] = ['seat', 'api'];

function validateBackendEntry(name: string, raw: unknown): DispatchResult<BackendEntry> {
  if (!isPlainObject(raw)) {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json must be an object.`);
  }

  // DEC-0046 Decision 1: secrets_file left the repo-table schema and now
  // lives in the host-local config (host-config.ts). A table that still
  // carries it refuses loudly, regardless of value (including null) — no
  // silent fallback, no dual read (rule 57).
  if ('secrets_file' in raw) {
    return fail(
      'BAD_RECORD',
      `Backend "${name}" in backends.json carries "secrets_file"; that field left the repo-table schema (DEC-0046) — move the path into the host-local config instead.`,
    );
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

  if (raw.request_params !== undefined && !isPlainObject(raw.request_params)) {
    return fail('BAD_RECORD', `Backend "${name}" in backends.json: "request_params" must be an object.`);
  }

  if (raw.billing !== undefined && !BILLING_KINDS.includes(raw.billing as 'seat' | 'api')) {
    return fail(
      'BAD_RECORD',
      `Backend "${name}" in backends.json: "billing" must be one of: ${BILLING_KINDS.join(', ')}.`,
    );
  }

  const entry: BackendEntry = {
    family: raw.family as BackendFamily,
    base_url: raw.base_url as string | null,
    api_key_env: raw.api_key_env as string | null,
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
  if (isPlainObject(raw.request_params)) entry.request_params = raw.request_params as Record<string, unknown>;
  if (typeof raw.billing === 'string') entry.billing = raw.billing as BackendEntry['billing'];
  return ok(entry);
}

const MODEL_TABLE_ENTRY_KNOWN_KEYS = new Set(['available_on', 'model_id', 'notes', 'inference', 'tool_call_parser', 'use_for', 'max_tokens']);

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
  if (raw.use_for !== undefined) {
    if (!Array.isArray(raw.use_for) || !raw.use_for.every((entry) => typeof entry === 'string')) {
      return fail('BAD_RECORD', `Model "${slug}" in models.json: "use_for" must be an array of strings when present.`);
    }
  }
  if (raw.max_tokens !== undefined) {
    if (typeof raw.max_tokens !== 'number' || !Number.isInteger(raw.max_tokens) || raw.max_tokens <= 0) {
      return fail('BAD_RECORD', `Model "${slug}" in models.json: "max_tokens" must be a positive integer when present.`);
    }
  }

  const entry: ModelTableEntry = {
    available_on: raw.available_on as string[],
    model_id: raw.model_id,
  };
  if (typeof raw.notes === 'string') entry.notes = raw.notes;
  if (isPlainObject(raw.inference)) entry.inference = raw.inference as Record<string, unknown>;
  if (typeof raw.tool_call_parser === 'string') entry.tool_call_parser = raw.tool_call_parser;
  if (Array.isArray(raw.use_for)) entry.use_for = raw.use_for as string[];
  if (typeof raw.max_tokens === 'number') entry.max_tokens = raw.max_tokens;
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

  // DEC-0046 Decision 1: inject used to map VAR_NAME -> file path; the path
  // half of that is a host fact and left the repo-table schema (host-config.ts
  // now holds it). The repo table keeps only the variable names a profile
  // injects, so an object-valued (old-shape) "inject" refuses loudly rather
  // than silently reinterpreting it.
  if (!Array.isArray(raw.inject)) {
    return fail(
      'BAD_RECORD',
      `Profile "${name}" in profiles.json must have "inject" as an array of variable names; a variable -> path mapping left the repo-table schema (DEC-0046) — move paths into the host-local config instead.`,
    );
  }

  const inject: string[] = [];
  for (const varName of raw.inject) {
    if (typeof varName !== 'string') {
      return fail('BAD_RECORD', `Profile "${name}" in profiles.json: "inject" must be an array of string variable names.`);
    }
    inject.push(varName);
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
 * Absolute (`/...`, or a Windows drive path like `C:\...`) or home (`~...`,
 * `$HOME`) path shape. Table validation (DEC-0046 / WK-0252) rejects any
 * string value matching this anywhere in a `wiki/.dispatch/*.json` table —
 * host facts belong in the host-local config (host-config.ts), never a
 * repo-tracked table. `base_url` is skipped (a URL, not a path).
 */
const ABSOLUTE_OR_HOME_PATH_RE = /^(\/|[A-Za-z]:[\\/]|~|\$HOME)/;

const PATH_SCAN_SKIP_KEYS = new Set(['base_url']);

/** Recursively find the first string value shaped like an absolute or home path, skipping `base_url` keys at any depth. */
function findPathLikeValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return ABSOLUTE_OR_HOME_PATH_RE.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findPathLikeValue(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (PATH_SCAN_SKIP_KEYS.has(key)) continue;
      const hit = findPathLikeValue(v);
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

/** Table validation (rule 28-provable): refuse a loaded table that carries an absolute or home path anywhere (DEC-0046). */
function rejectPathLikeStrings(raw: unknown, filename: string): DispatchResult<void> {
  const hit = findPathLikeValue(raw);
  if (hit !== null) {
    return fail(
      'BAD_RECORD',
      `${filename} contains an absolute or home path ("${hit}"); host facts such as secrets paths belong in the host-local config, not a repo-tracked table (DEC-0046).`,
    );
  }
  return ok(undefined);
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

  // Generic defense-in-depth, run after the field-specific checks above (so a
  // known field like secrets_file/inject still gets its own named message):
  // reject any absolute/home path anywhere else in the raw table (DEC-0046).
  const pathCheck = rejectPathLikeStrings(loaded.data, 'models.json');
  if (!pathCheck.ok) return pathCheck;

  return ok(table);
}

/**
 * Load `wiki/.dispatch/backends.json` (name -> family/base_url/api_key_env/notes). A
 * `secrets_file` key refuses (DEC-0046: that path moved to the host-local config).
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

  // Generic defense-in-depth, run after the field-specific checks above (so
  // secrets_file still gets its own named message): reject any absolute/home
  // path anywhere else in the raw table (DEC-0046). base_url is a URL, not a
  // path, and is skipped.
  const pathCheck = rejectPathLikeStrings(loaded.data, 'backends.json');
  if (!pathCheck.ok) return pathCheck;

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

  // Generic defense-in-depth, run after the field-specific checks above (so
  // a path-valued inject still gets its own named message): reject any
  // absolute/home path anywhere else in the raw table (DEC-0046).
  const pathCheck = rejectPathLikeStrings(loaded.data, 'profiles.json');
  if (!pathCheck.ok) return pathCheck;

  return ok({ schemaVersion: 1, profiles });
}
