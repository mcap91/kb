/**
 * Shared body-table reader (WK-0211).
 *
 * Reads one optional markdown table out of a record body's "## <heading>" section.
 * Shared by WK-0211's "## Slices" and WK-0212's "## Resolutions" / "## Hardening".
 *
 * Row splitting mirrors (not imports — validate-plan.ts is out of scope) the row
 * splitter in validate-plan.ts:348-356, extended with GFM's escaped-pipe rule:
 * `\|` inside a cell is a literal pipe, not a column separator.
 */

import { ok, fail, type Result } from './errors.js';
import {
  sliceRowSchema,
  type SliceRow,
  hardeningRowSchema,
  type HardeningRow,
  resolutionRowSchema,
  type ResolutionRow,
} from './schemas.js';

/** One row of a body table, keyed by column name. */
export type BodyTableRow = Record<string, string>;

/** Fixed `## Slices` header (WK-0211 Scope). */
export const SLICE_COLUMNS = [
  'id',
  'title',
  'write_scope',
  'depends_on',
  'validation',
  'status',
] as const;

/** Fixed `## Hardening` header (WK-0212 Scope). */
export const HARDENING_COLUMNS = ['#', 'date', 'check', 'by', 'verdict', 'notes'] as const;

/** Fixed `## Resolutions` header (WK-0212 Scope). */
export const RESOLUTIONS_COLUMNS = [
  '#',
  'date',
  'seat',
  'question',
  'searched',
  'evidence',
  'options',
  'choice',
  'reason',
  'cold check',
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove HTML comments (`<!-- ... -->`) so heading/table detection never sees commented-out examples. */
function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * True if the body has a `## <heading>` section at all. Used by `readSlices` to
 * distinguish "no table" (ok, optional feature unused) from "table present but
 * malformed" (a `readBodyTable` failure). Ignores HTML comments.
 */
function hasSection(body: string, heading: string): boolean {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm');
  return re.test(stripHtmlComments(body));
}

/**
 * Slice a `## <heading>` section's content out of the body, up to the next `## `
 * heading or EOF. Ignores HTML comments.
 */
function getSectionContent(body: string, heading: string): string {
  const stripped = stripHtmlComments(body);
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm');
  const match = re.exec(stripped);
  if (!match) return '';

  const start = match.index + match[0].length;
  const nextHeading = stripped.indexOf('\n## ', start);
  return nextHeading === -1 ? stripped.slice(start) : stripped.slice(start, nextHeading);
}

/**
 * Split one markdown table row into cells. Mirrors validate-plan.ts's splitTableRow
 * (strip the leading/trailing `|`, trim each cell), plus the GFM escape rule: `\|`
 * is a literal pipe inside a cell, not a cell boundary.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailing = inner.endsWith('|') ? inner.slice(0, -1) : inner;

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < withoutTrailing.length; i++) {
    const ch = withoutTrailing[i];
    if (ch === '\\' && withoutTrailing[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** Split a list cell (`write_scope`, `depends_on`) on `,`, trim each entry; empty cell -> []. */
function splitListCell(cell: string): string[] {
  const trimmed = cell.trim();
  if (trimmed === '') return [];
  return trimmed
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Find and parse one markdown table under a body's `## <heading>` section.
 *
 * Never throws. Fails on:
 *   - the `## <heading>` section not existing at all
 *   - the table's header row not matching `columns` exactly (name, order, count)
 *   - a data row whose cell count does not match the header
 */
export function readBodyTable(
  body: string,
  heading: string,
  columns: readonly string[],
): Result<BodyTableRow[]> {
  if (!hasSection(body, heading)) {
    return fail('PARSE_ERROR', `Section "## ${heading}" not found`);
  }

  const section = getSectionContent(body, heading);
  const tableLines = section.split('\n').filter(l => l.trim().startsWith('|'));

  if (tableLines.length < 2) {
    return fail('PARSE_ERROR', `No markdown table found under "## ${heading}"`);
  }

  const header = splitTableRow(tableLines[0]);
  const expected = [...columns];
  const headerMatches =
    header.length === expected.length && header.every((cell, i) => cell === expected[i]);
  if (!headerMatches) {
    return fail(
      'PARSE_ERROR',
      `Header mismatch under "## ${heading}": expected "${expected.join(' | ')}", got "${header.join(' | ')}"`,
    );
  }

  const rows: BodyTableRow[] = [];
  for (const line of tableLines.slice(2)) {
    const cells = splitTableRow(line);
    if (cells.length !== expected.length) {
      return fail(
        'PARSE_ERROR',
        `Row under "## ${heading}" has ${cells.length} cell(s), expected ${expected.length}: "${line.trim()}"`,
      );
    }
    const row: BodyTableRow = {};
    for (let i = 0; i < expected.length; i++) {
      row[expected[i]] = cells[i];
    }
    rows.push(row);
  }

  return ok(rows);
}

/**
 * Read the WK's optional `## Slices` body table. No `## Slices` section is the
 * normal case (the feature is optional) and returns `ok([])`, not a failure.
 */
export function readSlices(wk: string): Result<SliceRow[]> {
  if (!hasSection(wk, 'Slices')) {
    return ok([]);
  }

  const tableResult = readBodyTable(wk, 'Slices', SLICE_COLUMNS);
  if (!tableResult.ok) return tableResult;

  const rows: SliceRow[] = [];
  for (const raw of tableResult.data) {
    const candidate = {
      id: raw.id,
      title: raw.title,
      write_scope: splitListCell(raw.write_scope),
      depends_on: splitListCell(raw.depends_on),
      validation: raw.validation,
      status: raw.status,
    };
    const parsed = sliceRowSchema.safeParse(candidate);
    if (!parsed.success) {
      return fail(
        'SCHEMA_VALIDATION',
        `Invalid "## Slices" row "${raw.id}": ${parsed.error.issues.map(i => i.message).join('; ')}`,
      );
    }
    rows.push(parsed.data);
  }

  return ok(rows);
}

/**
 * Read the WK's optional `## Hardening` body table. No `## Hardening` section is the
 * normal case (the feature is optional) and returns `ok([])`, not a failure.
 */
export function readHardening(wk: string): Result<HardeningRow[]> {
  if (!hasSection(wk, 'Hardening')) {
    return ok([]);
  }

  const tableResult = readBodyTable(wk, 'Hardening', HARDENING_COLUMNS);
  if (!tableResult.ok) return tableResult;

  const rows: HardeningRow[] = [];
  for (const raw of tableResult.data) {
    const candidate = {
      num: raw['#'],
      date: raw.date,
      check: raw.check,
      by: raw.by,
      verdict: raw.verdict,
      notes: raw.notes,
    };
    const parsed = hardeningRowSchema.safeParse(candidate);
    if (!parsed.success) {
      return fail(
        'SCHEMA_VALIDATION',
        `Invalid "## Hardening" row "${raw['#']}": ${parsed.error.issues.map(i => i.message).join('; ')}`,
      );
    }
    rows.push(parsed.data);
  }

  return ok(rows);
}

/**
 * Read the WK's optional `## Resolutions` body table. No `## Resolutions` section is
 * the normal case (the feature is optional) and returns `ok([])`, not a failure.
 */
export function readResolutions(wk: string): Result<ResolutionRow[]> {
  if (!hasSection(wk, 'Resolutions')) {
    return ok([]);
  }

  const tableResult = readBodyTable(wk, 'Resolutions', RESOLUTIONS_COLUMNS);
  if (!tableResult.ok) return tableResult;

  const rows: ResolutionRow[] = [];
  for (const raw of tableResult.data) {
    const candidate = {
      num: raw['#'],
      date: raw.date,
      seat: raw.seat,
      question: raw.question,
      searched: raw.searched,
      evidence: raw.evidence,
      options: raw.options,
      choice: raw.choice,
      reason: raw.reason,
      coldCheck: raw['cold check'],
    };
    const parsed = resolutionRowSchema.safeParse(candidate);
    if (!parsed.success) {
      return fail(
        'SCHEMA_VALIDATION',
        `Invalid "## Resolutions" row "${raw['#']}": ${parsed.error.issues.map(i => i.message).join('; ')}`,
      );
    }
    rows.push(parsed.data);
  }

  return ok(rows);
}
