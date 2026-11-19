/**
 * Value-list secret scrubber. The ONE home of the value-list
 * model and of the matching logic that rewrites a resolved credential value
 * out of the bytes a worker writes to stdout and stderr.
 *
 * The list is built from the exact `name -> value` pairs a run injects
 * (`resolveCredentialEnv`'s output) plus, for a later slice, every string
 * leaf of a parsed credential file. A value is only ever eligible once it is
 * long enough to not be a coincidence (`MIN_VALUE_LENGTH`); short values are
 * dropped rather than scrubbed.
 *
 * Each value is matched in five forms — raw, JSON-escaped once, JSON-escaped
 * twice, `encodeURIComponent`, and standard base64 of its UTF-8 bytes — so a
 * value that a worker echoes inside a JSON string, a JSON-in-JSON string, a
 * URL, or a base64 blob is still caught. Equal forms collapse to one. A match
 * is leftmost-longest; a tie is resolved by the value's position in list
 * order, so the first value named wins. The replacement is
 * `[REDACTED:<name>]`, with any `"` or `\` in the name written as `_` so the
 * marker can never break out of an enclosing JSON string.
 *
 * `createSecretScrubber` is the streaming seam: each `push()` scans its whole
 * buffer, emits everything before a computed cut, and holds the rest, so a
 * value split across two `push()` calls (or containing a newline) is still
 * caught; `flush()` emits the held tail. `scrubText` is the same matcher over
 * a whole string.
 */
import { readFile } from 'node:fs/promises';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { loadBackendsTable, loadProfilesConfig } from './repo-config.js';
import { writeAtomic } from './run-state.js';

/** A value below this length (UTF-16 code units) is too short to be treated as a secret. */
export const MIN_VALUE_LENGTH = 16;

/** One `name -> value` pair eligible for scrubbing. */
export interface SecretValuePair {
  name: string;
  value: string;
}

/** One resolved secret: the name that appears in the replacement marker. */
export interface SecretValue {
  name: string;
  value: string;
}

/** A credential file captured for a later slice's leaf walk. */
export interface CredentialFileSnapshot {
  /** The file's label, used verbatim as the leaf-name prefix. */
  label: string;
  /** The file's raw bytes. */
  bytes: string | Buffer;
}

export interface BuildSecretValueListInput {
  /** Direct `name -> value` pairs (this slice: exactly `resolveCredentialEnv`'s output). */
  values: ReadonlyArray<SecretValuePair>;
  /** Credential-file snapshots whose parsed JSON string leaves are added (reserved for a later slice). */
  snapshots?: ReadonlyArray<CredentialFileSnapshot>;
}

function isLongEnough(value: string): boolean {
  return value.length >= MIN_VALUE_LENGTH;
}

/** JSON-escape a string once, without the surrounding quotes. */
function jsonEscapeOnce(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** The replacement marker for a value's name; `"`/`\` are made inert. */
function replacementFor(name: string): string {
  return `[REDACTED:${name.replace(/["\\]/g, '_')}]`;
}

/**
 * Walk a parsed JSON value depth-first, calling `visit` for every string
 * leaf with its dotted/bracketed path (`a.b`, `a[0].b`). Object keys keep
 * their insertion order; arrays are visited by index.
 */
function walkStringLeaves(node: unknown, path: string, visit: (path: string, value: string) => void): void {
  if (typeof node === 'string') {
    visit(path, node);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const childPath = path.length === 0 ? `[${i}]` : `${path}[${i}]`;
      walkStringLeaves(node[i], childPath, visit);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      walkStringLeaves(child, childPath, visit);
    }
  }
}

interface Form {
  text: string;
  bytes: Buffer;
  byteLength: number;
  valueIndex: number;
}

/** Expand the list into matcher forms in list order, de-duplicating equal forms per value. */
function collectForms(list: ReadonlyArray<SecretValue>): Form[] {
  const forms: Form[] = [];
  for (let valueIndex = 0; valueIndex < list.length; valueIndex += 1) {
    const value = list[valueIndex]?.value ?? '';
    if (!isLongEnough(value)) continue;
    const candidates = [
      value,
      jsonEscapeOnce(value),
      jsonEscapeOnce(jsonEscapeOnce(value)),
      encodeURIComponent(value),
      Buffer.from(value, 'utf8').toString('base64'),
    ];
    const seen = new Set<string>();
    for (const text of candidates) {
      if (text.length === 0 || seen.has(text)) continue;
      seen.add(text);
      const bytes = Buffer.from(text, 'utf8');
      forms.push({ text, bytes, byteLength: bytes.length, valueIndex });
    }
  }
  return forms;
}

interface Occurrence {
  start: number;
  end: number;
  length: number;
  formIndex: number;
}

/** Every occurrence of every form in `buf`, overlapping occurrences included. */
function findOccurrences(buf: Buffer, forms: ReadonlyArray<Form>): Occurrence[] {
  const out: Occurrence[] = [];
  for (let formIndex = 0; formIndex < forms.length; formIndex += 1) {
    const form = forms[formIndex];
    if (form === undefined || form.byteLength === 0) continue;
    let pos = buf.indexOf(form.bytes, 0);
    while (pos !== -1) {
      out.push({ start: pos, end: pos + form.byteLength, length: form.byteLength, formIndex });
      pos = buf.indexOf(form.bytes, pos + 1);
    }
  }
  return out;
}

/**
 * Replace leftmost-longest matches in `buf` with their markers. `forms` must
 * have been collected from the same `list`; the function never mutates input.
 */
function scrubBufferForms(buf: Buffer, list: ReadonlyArray<SecretValue>, forms: ReadonlyArray<Form>): Buffer {
  if (buf.length === 0 || forms.length === 0) return buf;
  const occurrences = findOccurrences(buf, forms);
  if (occurrences.length === 0) return buf;

  // best match per start byte: longest wins; equal length -> earliest form in list order.
  const best = new Map<number, Occurrence>();
  for (const occ of occurrences) {
    const current = best.get(occ.start);
    if (
      current === undefined ||
      occ.length > current.length ||
      (occ.length === current.length && occ.formIndex < current.formIndex)
    ) {
      best.set(occ.start, occ);
    }
  }

  const pieces: Buffer[] = [];
  let cursor = 0;
  let i = 0;
  while (i < buf.length) {
    const match = best.get(i);
    if (match === undefined) {
      i += 1;
      continue;
    }
    if (i > cursor) pieces.push(buf.subarray(cursor, i));
    const name = list[forms[match.formIndex]?.valueIndex ?? 0]?.name ?? '';
    pieces.push(Buffer.from(replacementFor(name), 'utf8'));
    i = match.end;
    cursor = i;
  }
  if (cursor < buf.length) pieces.push(buf.subarray(cursor));
  return pieces.length === 0 ? Buffer.alloc(0) : Buffer.concat(pieces);
}

/**
 * The byte position up to which `buf` can be emitted without leaking any
 * value: start one byte inside the last form length, then walk that cut back
 * across every occurrence that straddles it until none does. Overlapping
 * occurrences merge, so the emitted prefix never splits a match.
 */
function computeCut(bufLength: number, occurrences: ReadonlyArray<Occurrence>, longestFormLength: number): number {
  let cut = Math.max(0, bufLength - (longestFormLength - 1));
  let changed = true;
  while (changed) {
    changed = false;
    for (const occ of occurrences) {
      if (occ.start < cut && occ.end > cut) {
        cut = occ.start;
        changed = true;
      }
    }
  }
  return cut;
}

/** Streaming secret scrubber: feed chunks, emit only bytes that cannot be part of a value, flush the held tail. */
export interface SecretScrubber {
  /** Scrub `chunk` and return the safe prefix; the remainder is held for the next call. */
  push(chunk: Buffer): Buffer;
  /** Return the held remainder, scrubbed. Emits nothing afterwards. */
  flush(): Buffer;
  /** Bytes currently held back. */
  heldBytes(): number;
}

/**
 * Create a scrubber over a value list. An empty list passes every byte
 * through unchanged; otherwise each `push()` holds back every byte from the
 * computed cut onward so a value split across calls is still caught.
 */
export function createSecretScrubber(list: ReadonlyArray<SecretValue>): SecretScrubber {
  const forms = collectForms(list);
  if (forms.length === 0) {
    return {
      push: (chunk: Buffer): Buffer => chunk,
      flush: (): Buffer => Buffer.alloc(0),
      heldBytes: (): number => 0,
    };
  }
  const longestFormLength = forms.reduce((max, form) => Math.max(max, form.byteLength), 0);
  let held = Buffer.alloc(0);

  return {
    push(chunk: Buffer): Buffer {
      const buf = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
      const occurrences = findOccurrences(buf, forms);
      const cut = computeCut(buf.length, occurrences, longestFormLength);
      const emitted = scrubBufferForms(buf.subarray(0, cut), list, forms);
      held = Buffer.from(buf.subarray(cut));
      return emitted;
    },
    flush(): Buffer {
      const rest = held;
      held = Buffer.alloc(0);
      return scrubBufferForms(rest, list, forms);
    },
    heldBytes(): number {
      return held.length;
    },
  };
}

/** The names present in `found`, in `list` order, each once (shared by the streaming detectors). */
export function namesInListOrder(list: ReadonlyArray<SecretValue>, found: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (found.has(entry.name) && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry.name);
    }
  }
  return out;
}

/** Streaming secret DETECTOR: feed chunks, then ask which values were seen. Emits nothing. */
export interface SecretMatcher {
  /** Feed `chunk`; a value may span calls. */
  push(chunk: Buffer): void;
  /** Names of every value found at least once, in list order, each once. */
  names(): string[];
}

/**
 * Create a detector over a value list. An empty list, or one that contributes
 * no encoded form, matches nothing and returns `[]`. Unlike
 * `createSecretScrubber` this never rewrites bytes; it exists so a caller can
 * answer "did the stream carry a value?" without ever holding or emitting the
 * value itself.
 */
export function createSecretMatcher(list: ReadonlyArray<SecretValue>): SecretMatcher {
  const forms = collectForms(list);
  if (forms.length === 0) {
    return {
      push: (): void => {},
      names: (): string[] => [],
    };
  }
  const longestFormLength = forms.reduce((max, form) => Math.max(max, form.byteLength), 0);
  const found = new Set<string>();
  let held = Buffer.alloc(0);

  return {
    push(chunk: Buffer): void {
      const buf = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
      const occurrences = findOccurrences(buf, forms);
      // Record EVERY complete form occurrence, including one that ends inside
      // the held region: `names()` must answer for a value whose last byte
      // arrives in the final chunk, when no further push will come.
      for (const occ of occurrences) {
        const name = list[forms[occ.formIndex]?.valueIndex ?? 0]?.name;
        if (name !== undefined) found.add(name);
      }
      const cut = computeCut(buf.length, occurrences, longestFormLength);
      held = Buffer.from(buf.subarray(cut));
    },
    names(): string[] {
      return namesInListOrder(list, found);
    },
  };
}

/** Scrub a whole string with the same value list and matcher. */
export function scrubText(text: string, list: ReadonlyArray<SecretValue>): string {
  const forms = collectForms(list);
  if (forms.length === 0 || text.length === 0) return text;
  return scrubBufferForms(Buffer.from(text, 'utf8'), list, forms).toString('utf8');
}

/**
 * Deep-copy `value`, scrubbing every string leaf of a plain object or array
 * with `scrubText`. An `Error` becomes `{ name, message }` with the message
 * scrubbed (its stack is dropped — a stack can quote an arbitrary caught
 * value). Numbers, booleans, null and undefined pass through unchanged, as
 * do non-plain objects (Date, Buffer, functions). The input is never
 * mutated.
 */
export function scrubValue<T>(value: T, list: ReadonlyArray<SecretValue>): T {
  if (typeof value === 'string') return scrubText(value, list) as T;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message, list) } as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, list)) as T;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubValue(child, list);
  }
  return out as T;
}

/**
 * Scrub a whole file in place. A missing file is `ok(false)`; a read or write
 * error is `FILE_WRITE_ERROR` naming the path only (never its content). An
 * unchanged file is not written, so its mtime is preserved.
 */
export async function scrubFileInPlace(path: string, list: ReadonlyArray<SecretValue>): Promise<DispatchResult<boolean>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok(false);
    return fail('FILE_WRITE_ERROR', `Failed to scrub ${path}.`, err);
  }
  const scrubbed = scrubText(text, list);
  if (scrubbed === text) return ok(false);
  try {
    await writeAtomic(path, scrubbed);
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to scrub ${path}.`, err);
  }
  return ok(true);
}

/**
 * Read one credential value out of a `NAME=value` line in `filePath` (no `~`
 * expansion — the path is used verbatim). The two `CREDENTIAL_NOT_CONFIGURED`
 * messages are the ones `resolveCredentialEnv` (pipeline.ts) has always
 * produced; this is their one home.
 */
export async function readCredentialLine(varName: string, filePath: string): Promise<DispatchResult<string>> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err) {
    return fail('CREDENTIAL_NOT_CONFIGURED', `Credential variable "${varName}" is not configured (could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}).`);
  }
  const line = content.replace(/\r\n/g, '\n').split('\n').find((l) => l.startsWith(`${varName}=`));
  if (line === undefined) {
    return fail('CREDENTIAL_NOT_CONFIGURED', `Credential variable "${varName}" is not configured (missing from its named source file).`);
  }
  return ok(line.slice(varName.length + 1));
}

/**
 * Build the value list from the credentials kb already knows about on this
 * host: every profile `inject` value in profiles.json and every backend's
 * `api_key_env` read from its `secrets_file`. A value whose read fails is
 * skipped with one stderr line that names the var and its file and carries
 * no content. A loader failure (e.g. `BAD_RECORD`) is returned as the
 * failure. Credential-file leaves (claude, codex) are not included.
 */
export async function loadKnownSecretValues(dir: string): Promise<DispatchResult<SecretValue[]>> {
  const profiles = await loadProfilesConfig(dir);
  if (!profiles.ok) return profiles;
  const backends = await loadBackendsTable(dir);
  if (!backends.ok) return backends;

  const pairs: SecretValuePair[] = [];
  for (const profile of Object.values(profiles.data.profiles)) {
    for (const [varName, filePath] of Object.entries(profile.inject)) {
      const line = await readCredentialLine(varName, filePath);
      if (!line.ok) {
        process.stderr.write(`[secret-scrub] warning: skipped ${varName} from ${filePath}: ${line.error}\n`);
        continue;
      }
      pairs.push({ name: varName, value: line.data });
    }
  }
  for (const backend of Object.values(backends.data)) {
    if (backend.api_key_env === null || backend.secrets_file === null) continue;
    const line = await readCredentialLine(backend.api_key_env, backend.secrets_file);
    if (!line.ok) {
      process.stderr.write(`[secret-scrub] warning: skipped ${backend.api_key_env} from ${backend.secrets_file}: ${line.error}\n`);
      continue;
    }
    pairs.push({ name: backend.api_key_env, value: line.data });
  }
  return buildSecretValueList({ values: pairs });
}

/**
 * Build the ordered value list. Direct pairs come first, in input order,
 * then every string leaf of each snapshot's parsed JSON, in walk order and
 * named `<label>:<path>`. A snapshot whose bytes are not JSON fails the
 * build with a message naming the label only — never the bytes.
 */
export function buildSecretValueList(input: BuildSecretValueListInput): DispatchResult<SecretValue[]> {
  const list: SecretValue[] = [];
  for (const pair of input.values) {
    if (isLongEnough(pair.value)) list.push({ name: pair.name, value: pair.value });
  }
  for (const snapshot of input.snapshots ?? []) {
    const text = typeof snapshot.bytes === 'string' ? snapshot.bytes : snapshot.bytes.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // The parse error's message can quote the input, so carry only its name.
      const cause = error instanceof Error ? error.name : 'unknown error';
      return fail(
        'CREDENTIAL_NOT_CONFIGURED',
        `Credential snapshot "${snapshot.label}" is not valid JSON (${cause}); cannot build the secret value list.`,
      );
    }
    walkStringLeaves(parsed, '', (path, value) => {
      if (!isLongEnough(value)) return;
      const name = path.length === 0 ? snapshot.label : `${snapshot.label}:${path}`;
      list.push({ name, value });
    });
  }
  return ok(list);
}
