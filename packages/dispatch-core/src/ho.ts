/**
 * §5 HO frontmatter parsing (dispatch v2, PLN-0004 S0; mode gate removed at S4).
 *
 * This is a NEW record shape, distinct from v1's `HandoffFrontmatter` (types.ts).
 * It lives alongside v1 and does not replace it — v1 stays live until the S7 cutover
 * (DEC-0008 D17). All four §6 modes are valid frontmatter values and parse
 * successfully here — this module validates SCHEMA only. Which modes can actually
 * EXECUTE is a pipeline concern (S4 admission's envelope-ceiling checks, plus the
 * S6 mode-execution guard in pipeline.ts), not a parse-time one.
 *
 * No `yaml` package is available in this workspace (verified: not a declared
 * dependency anywhere in the monorepo) and this file may not add one — package.json
 * is wave-3 territory. Frontmatter is parsed with a small hand-rolled parser scoped to
 * exactly the §5 shape (scalars, booleans, null, inline `[...]` arrays, and multi-line
 * `- ` block arrays).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok } from './errors.js';

/** The four §6 mode ceilings — all valid at parse time; execution support is a pipeline concern. */
export type HandoffMode = 'implement' | 'code_review' | 'redteam' | 'research';

const VALID_MODES: readonly HandoffMode[] = ['implement', 'code_review', 'redteam', 'research'];

/**
 * §5 HO-*.md frontmatter (rev 5). Distinct from v1's `HandoffFrontmatter` in types.ts.
 */
export interface Handoff {
  id: string;
  title: string;
  mode: HandoffMode;
  write_scope: string[];
  base_ref: string | null;
  web: boolean;
  credentials: string[];
  data_mounts: string[];
  read_first: string[];
  vars: string[]; // Array of "KEY=value" strings; non-secret literal env for the worker
  acceptance: string[];
  validation: string[];
  status: string;
  // --- written back by dispatch after the run ---
  run_id?: string;
  agent?: string;
  model?: string;
  enforced?: boolean;
  isolation_backend?: string;
  credentials_granted?: string[];
  branch?: string;
  response?: string;
}

// New v2 error code. `bad_record` is the only refusal ho.ts itself produces
// (spec §7.1); will be merged into the shared DispatchErrorCode union in errors.ts
// at wave-3 integration. errors.ts is not modified by this file (wave-1 constraint).
type HoErrorCode = 'BAD_RECORD';

function fail<T = never>(message: string, detail?: unknown): DispatchResult<T> {
  return { ok: false, error: 'BAD_RECORD' as HoErrorCode, message, detail } as unknown as DispatchResult<T>;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => unquote(part.trim()));
  }
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return unquote(trimmed);
}

/**
 * Minimal frontmatter YAML parser scoped to the §5 HO shape: top-level scalars
 * (string/number/boolean/null), inline `[...]` arrays, and multi-line `- ` block
 * arrays. Throws on lines it cannot interpret as key/value or list-continuation —
 * callers must catch and translate to a DispatchResult.
 */
function parseFrontmatterYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const bulletMatch = line.match(/^\s+-\s?(.*)$/);
    if (bulletMatch && currentKey !== null) {
      if (currentList === null) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(unquote((bulletMatch[1] ?? '').trim()));
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      throw new Error(`Unrecognized frontmatter line: ${line}`);
    }

    const key = kvMatch[1]!;
    const rest = kvMatch[2] ?? '';
    currentKey = key;
    currentList = null;
    result[key] = parseScalar(rest);
  }

  return result;
}

function splitFrontmatter(content: string): { frontmatterText: string; body: string } | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatterText: match[1] ?? '', body: match[2] ?? '' };
}

const REQUIRED_FIELDS = ['id', 'title', 'mode', 'write_scope', 'acceptance', 'validation', 'status'] as const;

/**
 * Parse §5 HO frontmatter from already-loaded markdown content. Synchronous —
 * intended for tests and for callers that already have the file content in hand.
 *
 * @param filename Used only for the id/filename cross-check (e.g. `HO-0002.md`,
 *   or a full path — only the basename, minus a trailing `.md`, is compared).
 */
export function parseHandoffContent(content: string, filename: string): DispatchResult<Handoff> {
  const split = splitFrontmatter(content);
  if (!split) {
    return fail('Handoff file must begin with YAML frontmatter delimited by --- markers.');
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseFrontmatterYaml(split.frontmatterText);
  } catch (err) {
    return fail('Failed to parse handoff frontmatter.', err);
  }

  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      return fail(`Missing required handoff field: ${field}`);
    }
  }

  const id = raw.id;
  if (typeof id !== 'string' || id.trim() === '') {
    return fail('Handoff id must be a non-empty string.');
  }

  const title = raw.title;
  if (typeof title !== 'string' || title.trim() === '') {
    return fail('Handoff title must be a non-empty string.');
  }

  const mode = raw.mode;
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as HandoffMode)) {
    return fail(`Handoff mode must be one of ${VALID_MODES.join(', ')}; got: ${String(mode)}`);
  }

  if (!Array.isArray(raw.write_scope) || !raw.write_scope.every((entry) => typeof entry === 'string')) {
    return fail('Handoff write_scope must be an array of strings.');
  }

  if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0 || !raw.acceptance.every((entry) => typeof entry === 'string')) {
    return fail('Handoff acceptance must be a non-empty array of strings.');
  }

  if (!Array.isArray(raw.validation) || raw.validation.length === 0 || !raw.validation.every((entry) => typeof entry === 'string')) {
    return fail('Handoff validation must be a non-empty array of strings.');
  }

  const status = raw.status;
  if (typeof status !== 'string' || status.trim() === '') {
    return fail('Handoff status must be a non-empty string.');
  }

  const expectedId = basename(filename).replace(/\.md$/i, '');
  if (expectedId !== id) {
    return fail(`Handoff id "${id}" does not match filename "${filename}" (expected id "${expectedId}").`);
  }

  const baseRefRaw = raw.base_ref;
  if (baseRefRaw !== undefined && baseRefRaw !== null && typeof baseRefRaw !== 'string') {
    return fail('Handoff base_ref must be a string or null.');
  }

  if (raw.credentials !== undefined && (!Array.isArray(raw.credentials) || !raw.credentials.every((entry) => typeof entry === 'string'))) {
    return fail('Handoff credentials must be an array of strings.');
  }

  if (raw.data_mounts !== undefined && (!Array.isArray(raw.data_mounts) || !raw.data_mounts.every((entry) => typeof entry === 'string'))) {
    return fail('Handoff data_mounts must be an array of strings.');
  }

  if (raw.read_first !== undefined && (!Array.isArray(raw.read_first) || !raw.read_first.every((entry) => typeof entry === 'string'))) {
    return fail('Handoff read_first must be an array of strings.');
  }

  if (raw.vars !== undefined && (!Array.isArray(raw.vars) || !raw.vars.every((entry) => typeof entry === 'string'))) {
    return fail('Handoff vars must be an array of "KEY=value" strings.');
  }

  const handoff: Handoff = {
    id,
    title,
    mode: mode as HandoffMode,
    write_scope: raw.write_scope as string[],
    base_ref: (baseRefRaw as string | null | undefined) ?? null,
    web: raw.web === true,
    credentials: Array.isArray(raw.credentials) ? (raw.credentials as string[]) : [],
    data_mounts: Array.isArray(raw.data_mounts) ? (raw.data_mounts as string[]) : [],
    read_first: Array.isArray(raw.read_first) ? (raw.read_first as string[]) : [],
    vars: Array.isArray(raw.vars) ? (raw.vars as string[]) : [],
    acceptance: raw.acceptance as string[],
    validation: raw.validation as string[],
    status,
  };

  if (typeof raw.run_id === 'string') handoff.run_id = raw.run_id;
  if (typeof raw.agent === 'string') handoff.agent = raw.agent;
  if (typeof raw.model === 'string') handoff.model = raw.model;
  if (typeof raw.enforced === 'boolean') handoff.enforced = raw.enforced;
  if (typeof raw.isolation_backend === 'string') handoff.isolation_backend = raw.isolation_backend;
  if (Array.isArray(raw.credentials_granted) && raw.credentials_granted.every((entry) => typeof entry === 'string')) {
    handoff.credentials_granted = raw.credentials_granted as string[];
  }
  if (typeof raw.branch === 'string') handoff.branch = raw.branch;
  if (typeof raw.response === 'string') handoff.response = raw.response;

  return ok(handoff);
}

/**
 * Read and parse a §5 HO-*.md file from disk.
 */
export async function parseHandoff(filePath: string): Promise<DispatchResult<Handoff>> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err) {
    return fail(`Failed to read handoff file: ${filePath}`, err);
  }

  return parseHandoffContent(content, filePath);
}
