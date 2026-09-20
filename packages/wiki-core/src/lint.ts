/**
 * Wiki linting module.
 *
 * Scans all manifest-driven wiki records in the target repo, validates
 * frontmatter against Zod schemas and manifest definitions, and reports
 * structured diagnostics.
 *
 * Scope:
 *   - Iterates manifest-driven record directories (issues, initiatives, etc.)
 *   - Excludes wiki/handoffs/
 *   - Excludes generated views (files with `_generated: true` frontmatter)
 *
 * Lint rules:
 *   - PARSE_ERROR                   — YAML frontmatter cannot be parsed
 *   - MISSING_FIELD                 — required frontmatter field absent
 *   - INVALID_ENUM                  — field value not in manifest enum set
 *   - DUPLICATE_ID                  — multiple records share the same ID
 *   - DEPENDENCY_CYCLE              — a depends_on edge cycle exists among records
 *   - BROKEN_REFERENCE              — depends_on / blocks / related / area / initiative
 *                                     points to a nonexistent record
 *   - INVALID_INITIATIVE_TARGET     — initiative resolves, but not to a wiki/initiatives/ record
 *   - MISSING_SUPERSEDES_TARGET     — supersedes points to a nonexistent record
 *   - MISSING_SUPERSEDED_BY_TARGET  — superseded_by points to a nonexistent record
 *   - MISSING_RELATED_DOCS_TARGET   — (SRC) related_docs path does not exist on disk
 *   - MISSING_RELATED_WORK_TARGET   — (SRC) related_work points to a nonexistent record
 *   - STALE_WRITE_SCOPE             — (warning) write_scope path does not exist on disk
 *   - MISSING_DOCS_TARGET           — (warning) docs path does not exist on disk
 *   - ORPHAN_WK                     — (warning) WK record has no initiative set
 *   - AC_COMPLETE_STATUS_OPEN       — (warning) all "## Acceptance criteria" boxes are
 *                                     checked but status has not advanced past an open state
 *   - UNCHECKED_CHECKLIST           — (error) closed/terminal-status record has unchecked
 *                                     items in its "## Acceptance criteria" section
 *   - OPEN_CHILD_UNDER_TERMINAL_PARENT — (warning, cross-record, WK-0114) a WK's
 *                                     initiative has a terminal status (done/cancelled) but
 *                                     the WK's own status is not done/cancelled/parked
 *   - INITIATIVE_READY_TO_CLOSE     — (warning, cross-record, WK-0114) an initiative has
 *                                     >=1 WK child, is not itself closed, and every child
 *                                     is closed — advisory only, never auto-closes
 *   - STALE_ACTIVE_ISSUE            — (warning, cross-record, WK-0114) a WK in an active
 *                                     status (in_progress/blocked/review) has not been
 *                                     updated in >=14 days, measured against a
 *                                     corpus-relative clock (max "updated" across all
 *                                     records), never wall-clock time
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  LintOpts,
  LintDiagnostic,
  LintResult,
  WikiManifest,
  ManifestRecordType,
} from './types.js';
import { loadManifest } from './contract.js';
import { frontmatterSchemas } from './schemas.js';
import { debug, setVerbose } from './debug.js';
import { buildDependencyProjection } from './deps.js';

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface ParsedRecord {
  /** Path relative to target dir using forward slashes. */
  relPath: string;
  /** Absolute file path. */
  absPath: string;
  /** Parsed frontmatter object, or null if parsing failed. */
  frontmatter: Record<string, unknown> | null;
  /** Raw body (after frontmatter). */
  body: string;
  /** The manifest type key this file belongs to (e.g. "issue"). */
  typeKey: string;
  /** The manifest record type definition. */
  typeDef: ManifestRecordType;
}

/**
 * Minimal YAML frontmatter parser.
 * Extracts content between leading `---` fences and parses key-value pairs.
 * Returns null if the file has no valid frontmatter fence.
 */
function parseFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const trimmed = raw.replace(/\r\n/g, '\n').replace(/^﻿/, ''); // strip BOM
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(4, endIdx);
  const body = trimmed.slice(endIdx + 4);
  const data: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    // Array item continuation
    if (currentKey && currentArray !== null) {
      const arrayItemMatch = line.match(/^  ?- (.*)$/);
      if (arrayItemMatch) {
        const val = arrayItemMatch[1].trim().replace(/^["']|["']$/g, '');
        if (val) currentArray.push(val);
        continue;
      }
      // Array ended — flush
      data[currentKey] = currentArray.length > 0 ? currentArray : undefined;
      currentArray = null;
      currentKey = null;
    }

    // Top-level key: value
    const kvMatch = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (kvMatch) {
      const key = kvMatch[1];
      let value: unknown = kvMatch[2].trim();

      // Empty value — could be start of an array or null
      if (value === '' || value === 'null' || value === '~') {
        // Peek: might be an array on subsequent lines — set up tracking
        currentKey = key;
        currentArray = [];
        continue;
      }

      // Inline array: [a, b, c]
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
          data[key] = undefined;
        } else {
          data[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        }
        continue;
      }

      // Strip surrounding quotes
      if (typeof value === 'string') {
        value = value.replace(/^["']|["']$/g, '');
      }

      // Boolean coercion
      if (value === 'true') value = true;
      else if (value === 'false') value = false;

      data[key] = value;
      continue;
    }
  }

  // Flush any trailing array
  if (currentKey && currentArray !== null) {
    data[currentKey] = currentArray.length > 0 ? currentArray : undefined;
  }

  return { data, body };
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Collect all markdown files from a directory (non-recursive, single level).
 */
function listMarkdownFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs
      .readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dirPath, f));
  } catch {
    return [];
  }
}

/**
 * Check whether a parsed file is a generated view (has `_generated: true`).
 */
function isGenerated(fm: Record<string, unknown> | null): boolean {
  if (!fm) return false;
  return fm['_generated'] === true || fm['_generated'] === 'true';
}

// ---------------------------------------------------------------------------
// Acceptance-criteria section helpers (WK-0050)
// ---------------------------------------------------------------------------

/**
 * Extract the checkbox lines (`- [ ]` / `- [x]`) from a record body's
 * "## Acceptance criteria" section — from that heading up to (but not
 * including) the next `##` heading, or EOF. Returns an empty array if the
 * section is absent.
 *
 * Scoping to this section only (rather than the whole body) is deliberate:
 * a stray open box under an unrelated `## Checklist` heading must not trip
 * AC_COMPLETE_STATUS_OPEN or the build-breaking UNCHECKED_CHECKLIST error.
 * Both rules call this single helper so the section-slicing isn't duplicated.
 */
function extractAcceptanceCriteriaCheckboxes(body: string): string[] {
  const lines = body.split('\n');
  const headingIdx = lines.findIndex(line =>
    /^##\s+Acceptance criteria\s*$/i.test(line.trim()),
  );
  if (headingIdx === -1) return [];

  const checkboxes: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^##\s+/.test(trimmed)) break;
    if (/^-\s*\[[ xX]\]/.test(trimmed)) {
      checkboxes.push(trimmed);
    }
  }
  return checkboxes;
}

/** True if a checkbox line (as returned by extractAcceptanceCriteriaCheckboxes) is checked. */
function isCheckedBox(line: string): boolean {
  return /^-\s*\[[xX]\]/.test(line);
}

// ---------------------------------------------------------------------------
// Cross-record status-coherence helpers (WK-0114)
// ---------------------------------------------------------------------------

/**
 * Parse a strict `YYYY-MM-DD` date string into a UTC Date. Returns null for anything
 * that isn't exactly that shape, or that doesn't round-trip to a real calendar date
 * (e.g. "2025-13-40" would otherwise silently roll forward under plain `Date` parsing).
 */
function parseDate(dateStr: string): Date | null {
  if (typeof dateStr !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Reject overflowed components (Date otherwise rolls Feb 30 into Mar 2, etc.).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * The corpus-relative "now": the maximum parseable `updated` date across all records.
 * STALE_ACTIVE_ISSUE measures staleness against this instead of wall-clock time, so
 * `lint()` stays a pure function of the file tree — same tree in, same diagnostics out,
 * forever (no `Date.now()`, no bare `new Date()`). Accepted limitation: "stale" is
 * relative to whichever record was most recently touched, not to real elapsed time —
 * documented in contract/lint.md.
 */
function corpusLatestDate(records: ParsedRecord[]): Date | null {
  let latest: Date | null = null;
  for (const rec of records) {
    if (!rec.frontmatter) continue;
    const updated = rec.frontmatter['updated'];
    if (typeof updated !== 'string') continue;
    const parsed = parseDate(updated);
    if (parsed && (!latest || parsed.getTime() > latest.getTime())) {
      latest = parsed;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * Lint all manifest-driven wiki records in the target repo.
 *
 * Returns a structured result with diagnostics, counts, and pass/fail status.
 */
export async function lint(opts: LintOpts): Promise<Result<LintResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  debug(`lint: target=${targetDir}`);

  // 1. Load manifest
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  // 2. Collect records from manifest-driven directories
  const records: ParsedRecord[] = [];
  const generatedViewFiles = new Set(
    manifest.generatedViews.standardFiles.map(f =>
      path.resolve(targetDir, f.replace(/\//g, path.sep)),
    ),
  );

  for (const [typeKey, typeDef] of Object.entries(manifest.types)) {
    if (typeDef.prefix === 'HO') continue;

    const dir = path.join(targetDir, typeDef.directory.replace(/\//g, path.sep));
    const files = listMarkdownFiles(dir);

    for (const absPath of files) {
      const basename = path.basename(absPath);

      // Skip reserved filenames
      if (typeDef.reservedFilenames.includes(basename)) {
        debug(`lint: skipping reserved file ${basename}`);
        continue;
      }

      // Skip generated views
      if (generatedViewFiles.has(path.resolve(absPath))) {
        debug(`lint: skipping generated view ${basename}`);
        continue;
      }

      const raw = fs.readFileSync(absPath, 'utf-8');
      const parsed = parseFrontmatter(raw);

      // Also skip files that have _generated marker
      if (parsed && isGenerated(parsed.data)) {
        debug(`lint: skipping generated file ${basename}`);
        continue;
      }

      const relPath = path.relative(targetDir, absPath).replace(/\\/g, '/');
      records.push({
        relPath,
        absPath,
        frontmatter: parsed ? parsed.data : null,
        body: parsed ? parsed.body : raw,
        typeKey,
        typeDef,
      });
    }
  }

  debug(`lint: collected ${records.length} records`);

  // 3. Run lint rules
  const diagnostics: LintDiagnostic[] = [];

  // Build a set of all known record IDs for reference validation
  const allIds = new Set<string>();
  const idLocations = new Map<string, string[]>();

  for (const rec of records) {
    if (!rec.frontmatter) continue;
    const id = rec.frontmatter['id'];
    if (typeof id === 'string' && id) {
      allIds.add(id);
      const locs = idLocations.get(id) || [];
      locs.push(rec.relPath);
      idLocations.set(id, locs);
    }
  }

  for (const rec of records) {
    // Rule: PARSE_ERROR — frontmatter could not be parsed
    if (rec.frontmatter === null) {
      diagnostics.push({
        file: rec.relPath,
        code: 'PARSE_ERROR',
        message: 'Could not parse YAML frontmatter',
        severity: 'error',
      });
      continue;
    }

    const fm = rec.frontmatter;

    // Rule: MISSING_FIELD — check required fields from manifest
    for (const field of rec.typeDef.requiredFrontMatter) {
      const val = fm[field];
      if (val === undefined || val === null || val === '') {
        diagnostics.push({
          file: rec.relPath,
          field,
          code: 'MISSING_FIELD',
          message: `Required field "${field}" is missing or empty`,
          severity: 'error',
        });
      }
    }

    // Rule: INVALID_ENUM — check enum fields from manifest
    if (rec.typeDef.enumFrontMatter) {
      for (const [field, allowed] of Object.entries(rec.typeDef.enumFrontMatter)) {
        const val = fm[field];
        if (val !== undefined && val !== null && val !== '') {
          if (typeof val === 'string' && !allowed.includes(val)) {
            diagnostics.push({
              file: rec.relPath,
              field,
              code: 'INVALID_ENUM',
              message: `Field "${field}" has invalid value "${val}". Allowed: ${allowed.join(', ')}`,
              severity: 'error',
            });
          }
        }
      }
    }

    // Rule: BROKEN_REFERENCE — validate record reference fields
    const refFields = ['depends_on', 'blocks', 'related'];
    for (const field of refFields) {
      const val = fm[field];
      if (Array.isArray(val)) {
        for (const ref of val) {
          if (typeof ref === 'string' && ref && !allIds.has(ref)) {
            diagnostics.push({
              file: rec.relPath,
              field,
              code: 'BROKEN_REFERENCE',
              message: `Reference "${ref}" in "${field}" does not match any known record ID`,
              severity: 'error',
            });
          }
        }
      }
    }

    // Scalar reference fields: area, initiative
    for (const field of ['area', 'initiative']) {
      const val = fm[field];
      if (typeof val === 'string' && val && !allIds.has(val)) {
        diagnostics.push({
          file: rec.relPath,
          field,
          code: 'BROKEN_REFERENCE',
          message: `Reference "${val}" in "${field}" does not match any known record ID`,
          severity: 'error',
        });
      }
    }

    // Rule: INVALID_INITIATIVE_TARGET — initiative resolves to a real record (the
    // BROKEN_REFERENCE check above did not fire), but that record does not live under
    // wiki/initiatives/.
    {
      const val = fm['initiative'];
      if (typeof val === 'string' && val && allIds.has(val)) {
        const locs = idLocations.get(val) || [];
        if (!locs.some(loc => loc.startsWith('wiki/initiatives/'))) {
          diagnostics.push({
            file: rec.relPath,
            field: 'initiative',
            code: 'INVALID_INITIATIVE_TARGET',
            message: `Reference "${val}" in "initiative" does not point to a record under wiki/initiatives/`,
            severity: 'error',
          });
        }
      }
    }

    // Rule: MISSING_SUPERSEDES_TARGET / MISSING_SUPERSEDED_BY_TARGET — set-but-unresolvable
    const supersedeFields: Array<[string, string]> = [
      ['supersedes', 'MISSING_SUPERSEDES_TARGET'],
      ['superseded_by', 'MISSING_SUPERSEDED_BY_TARGET'],
    ];
    for (const [field, code] of supersedeFields) {
      const val = fm[field];
      if (typeof val === 'string' && val && !allIds.has(val)) {
        diagnostics.push({
          file: rec.relPath,
          field,
          code,
          message: `Reference "${val}" in "${field}" does not match any known record ID`,
          severity: 'error',
        });
      }
    }

    // Rule: STALE_WRITE_SCOPE — each write_scope entry (minus any #anchor) must exist on disk
    {
      const val = fm['write_scope'];
      if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === 'string' && entry) {
            const strippedPath = entry.split('#')[0];
            const absPath = path.join(targetDir, strippedPath);
            if (!fs.existsSync(absPath)) {
              diagnostics.push({
                file: rec.relPath,
                field: 'write_scope',
                code: 'STALE_WRITE_SCOPE',
                message: `Path "${entry}" in "write_scope" does not exist on disk`,
                severity: 'warning',
              });
            }
          }
        }
      }
    }

    // Rule: MISSING_DOCS_TARGET — each docs entry must exist on disk. Plain existence,
    // NOT scoped to docs/** — records legitimately point docs at arbitrary repo paths.
    {
      const val = fm['docs'];
      if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === 'string' && entry) {
            const absPath = path.join(targetDir, entry);
            if (!fs.existsSync(absPath)) {
              diagnostics.push({
                file: rec.relPath,
                field: 'docs',
                code: 'MISSING_DOCS_TARGET',
                message: `Path "${entry}" in "docs" does not exist on disk`,
                severity: 'warning',
              });
            }
          }
        }
      }
    }

    // Rule: ORPHAN_WK — (warning, kb addition — not upstream) a WK record with no
    // initiative field at all. BROKEN_REFERENCE / INVALID_INITIATIVE_TARGET only fire on
    // a wrong reference, never an absent one (DEC-0035: advisory, not error).
    if (rec.typeDef.prefix === 'WK') {
      const val = fm['initiative'];
      if (val === undefined || val === null || val === '') {
        diagnostics.push({
          file: rec.relPath,
          field: 'initiative',
          code: 'ORPHAN_WK',
          message: 'WK record has no "initiative" set',
          severity: 'warning',
        });
      }
    }

    // Rule: MISSING_RELATED_DOCS_TARGET / MISSING_RELATED_WORK_TARGET — SRC only
    if (rec.typeDef.prefix === 'SRC') {
      const relatedDocs = fm['related_docs'];
      if (Array.isArray(relatedDocs)) {
        for (const docPath of relatedDocs) {
          if (typeof docPath === 'string' && docPath) {
            const absPath = path.join(targetDir, docPath);
            if (!fs.existsSync(absPath)) {
              diagnostics.push({
                file: rec.relPath,
                field: 'related_docs',
                code: 'MISSING_RELATED_DOCS_TARGET',
                message: `Path "${docPath}" in "related_docs" does not exist on disk`,
                severity: 'error',
              });
            }
          }
        }
      }

      const relatedWork = fm['related_work'];
      if (Array.isArray(relatedWork)) {
        for (const ref of relatedWork) {
          if (typeof ref === 'string' && ref && !allIds.has(ref)) {
            diagnostics.push({
              file: rec.relPath,
              field: 'related_work',
              code: 'MISSING_RELATED_WORK_TARGET',
              message: `Reference "${ref}" in "related_work" does not match any known record ID`,
              severity: 'error',
            });
          }
        }
      }
    }

    // Rule: AC_COMPLETE_STATUS_OPEN — (warning, WK-0050) all boxes in "## Acceptance
    // criteria" are checked but status has not advanced past an open state. `review`
    // is deliberately excluded — AC-complete awaiting review is legitimate, not drift.
    {
      const status = fm['status'];
      const acBoxes = extractAcceptanceCriteriaCheckboxes(rec.body);
      const openStatuses = ['todo', 'in_progress', 'blocked'];
      if (
        typeof status === 'string' &&
        openStatuses.includes(status) &&
        acBoxes.length > 0 &&
        acBoxes.every(isCheckedBox)
      ) {
        diagnostics.push({
          file: rec.relPath,
          code: 'AC_COMPLETE_STATUS_OPEN',
          message: `Acceptance criteria are all checked but status is still "${status}"`,
          severity: 'warning',
        });
      }
    }

    // Rule: UNCHECKED_CHECKLIST — (error, WK-0050 upgrade from warning) a closed/
    // terminal-status record has unchecked items in "## Acceptance criteria". Scoped
    // to that section only (not the whole body via `rec.body.includes('- [ ]')` as
    // before) so a stray open box under an unrelated "## Checklist" heading does not
    // trip a build-breaking error. `parked` is deliberately excluded — open AC on a
    // parked record is expected, not drift.
    {
      const status = fm['status'];
      const acBoxes = extractAcceptanceCriteriaCheckboxes(rec.body);
      const closedStatuses = ['done', 'cancelled', 'deprecated', 'duplicate', 'superseded', 'wont_do'];
      if (
        typeof status === 'string' &&
        closedStatuses.includes(status) &&
        acBoxes.some(line => !isCheckedBox(line))
      ) {
        diagnostics.push({
          file: rec.relPath,
          code: 'UNCHECKED_CHECKLIST',
          message: `Record status is "${status}" but its "## Acceptance criteria" section has unchecked items`,
          severity: 'error',
        });
      }
    }

    // Zod schema validation (for additional structural checks)
    const prefix = rec.typeDef.prefix;
    if (prefix && prefix in frontmatterSchemas) {
      const schema = frontmatterSchemas[prefix as keyof typeof frontmatterSchemas];
      const result = schema.safeParse(fm);
      if (!result.success) {
        // Only emit schema errors for issues not already covered by field/enum checks
        for (const issue of result.error.issues) {
          const fieldPath = issue.path.join('.');
          // Skip if we already reported a MISSING_FIELD or INVALID_ENUM for this field
          const alreadyReported = diagnostics.some(
            d =>
              d.file === rec.relPath &&
              d.field === fieldPath &&
              (d.code === 'MISSING_FIELD' || d.code === 'INVALID_ENUM'),
          );
          if (!alreadyReported) {
            diagnostics.push({
              file: rec.relPath,
              field: fieldPath || undefined,
              code: 'SCHEMA_VALIDATION',
              message: issue.message,
              severity: 'error',
            });
          }
        }
      }
    }
  }

  // Rule: DUPLICATE_ID — check for duplicate IDs across all records
  for (const [id, locs] of idLocations.entries()) {
    if (locs.length > 1) {
      for (const file of locs) {
        diagnostics.push({
          file,
          field: 'id',
          code: 'DUPLICATE_ID',
          message: `Duplicate ID "${id}" also found in: ${locs.filter(l => l !== file).join(', ')}`,
          severity: 'error',
        });
      }
    }
  }

  // Rule: DEPENDENCY_CYCLE — detect cycles in depends_on edges
  {
    const depNodes = records
      .filter(rec => rec.frontmatter !== null && typeof rec.frontmatter['id'] === 'string')
      .map(rec => {
        const fm = rec.frontmatter as Record<string, unknown>;
        return {
          id: fm['id'] as string,
          status: typeof fm['status'] === 'string' ? fm['status'] : 'unknown',
          depends_on: Array.isArray(fm['depends_on']) ? (fm['depends_on'] as string[]) : [],
          blocks: Array.isArray(fm['blocks']) ? (fm['blocks'] as string[]) : [],
        };
      });

    const projection = buildDependencyProjection(depNodes);
    for (const diag of projection.diagnostics) {
      if (diag.code !== 'cycle') continue;
      const firstId = diag.ids[0];
      const locs = idLocations.get(firstId) || [];
      diagnostics.push({
        file: locs[0] || '',
        code: 'DEPENDENCY_CYCLE',
        message: `Dependency cycle detected: ${diag.ids.join(' -> ')}`,
        severity: 'error',
      });
    }
  }

  // Rules: OPEN_CHILD_UNDER_TERMINAL_PARENT / INITIATIVE_READY_TO_CLOSE /
  // STALE_ACTIVE_ISSUE (all warnings, WK-0114) — cross-record status-coherence checks
  // over the full repo-wide `records` set built above. Design-mirror only (ELv2) of
  // upstream's initiative-status + lint-coordination-rules checks. Flag only; never
  // mutate a record.
  {
    const issuesByInitiative = new Map<string, ParsedRecord[]>();
    const initiatives: ParsedRecord[] = [];

    for (const rec of records) {
      if (!rec.frontmatter) continue;
      if (rec.typeDef.prefix === 'IN') {
        initiatives.push(rec);
      } else if (rec.typeDef.prefix === 'WK') {
        const initiative = rec.frontmatter['initiative'];
        if (typeof initiative === 'string' && initiative) {
          const list = issuesByInitiative.get(initiative) ?? [];
          list.push(rec);
          issuesByInitiative.set(initiative, list);
        }
      }
    }

    // Terminal parent = done/cancelled only — narrower than CLOSED_STATUSES below,
    // since a deprecated/superseded/wont_do initiative doesn't imply its children
    // should have stopped.
    const TERMINAL_PARENT_STATUSES = new Set(['done', 'cancelled']);
    // A child is "actionable" (and so drift-worthy under a terminal parent) unless its
    // status is one of these. `parked` is deliberately excluded — a parked child under
    // a terminal parent is expected, not drift.
    const CHILD_NOT_ACTIONABLE_STATUSES = new Set(['done', 'cancelled', 'parked']);
    // kb CLOSED_STATUSES = upstream's set minus `expired` (not a kb status — confirmed
    // against contract/manifest.json).
    const CLOSED_STATUSES = new Set([
      'done', 'cancelled', 'deprecated', 'duplicate', 'superseded', 'wont_do',
    ]);
    const ACTIVE_STATUSES = new Set(['in_progress', 'blocked', 'review']);
    const STALE_THRESHOLD_DAYS = 14;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    for (const initiative of initiatives) {
      const fm = initiative.frontmatter;
      if (!fm) continue;
      const initiativeId = typeof fm['id'] === 'string' ? fm['id'] : undefined;
      const initiativeStatus = typeof fm['status'] === 'string' ? fm['status'] : undefined;
      if (!initiativeId || !initiativeStatus) continue;

      const children = issuesByInitiative.get(initiativeId) ?? [];

      // Rule: OPEN_CHILD_UNDER_TERMINAL_PARENT
      if (TERMINAL_PARENT_STATUSES.has(initiativeStatus)) {
        for (const child of children) {
          const childFm = child.frontmatter;
          if (!childFm) continue;
          const childStatus =
            typeof childFm['status'] === 'string' ? childFm['status'] : undefined;
          if (childStatus && !CHILD_NOT_ACTIONABLE_STATUSES.has(childStatus)) {
            diagnostics.push({
              file: child.relPath,
              field: 'status',
              code: 'OPEN_CHILD_UNDER_TERMINAL_PARENT',
              message: `Status "${childStatus}" is still open under terminal parent initiative "${initiativeId}" (initiative status "${initiativeStatus}")`,
              severity: 'warning',
            });
          }
        }
      }

      // Rule: INITIATIVE_READY_TO_CLOSE — advisory only; never auto-closes the initiative.
      if (children.length > 0 && !CLOSED_STATUSES.has(initiativeStatus)) {
        const allChildrenClosed = children.every(child => {
          const childFm = child.frontmatter;
          const childStatus =
            childFm && typeof childFm['status'] === 'string' ? childFm['status'] : undefined;
          return childStatus !== undefined && CLOSED_STATUSES.has(childStatus);
        });
        if (allChildrenClosed) {
          diagnostics.push({
            file: initiative.relPath,
            field: 'status',
            code: 'INITIATIVE_READY_TO_CLOSE',
            message: `All ${children.length} child WK record(s) under "${initiativeId}" are closed but initiative status is still "${initiativeStatus}"`,
            severity: 'warning',
          });
        }
      }
    }

    // Rule: STALE_ACTIVE_ISSUE — measured against the corpus-relative clock, never
    // wall-clock time (see corpusLatestDate doc comment + contract/lint.md).
    const asOf = corpusLatestDate(records);
    if (asOf) {
      for (const rec of records) {
        if (rec.typeDef.prefix !== 'WK' || !rec.frontmatter) continue;
        const status = rec.frontmatter['status'];
        if (typeof status !== 'string' || !ACTIVE_STATUSES.has(status)) continue;

        const updated = rec.frontmatter['updated'];
        if (typeof updated !== 'string') continue;
        const updatedDate = parseDate(updated);
        if (!updatedDate) continue;

        const ageDays = Math.floor((asOf.getTime() - updatedDate.getTime()) / MS_PER_DAY);
        if (ageDays >= STALE_THRESHOLD_DAYS) {
          diagnostics.push({
            file: rec.relPath,
            field: 'updated',
            code: 'STALE_ACTIVE_ISSUE',
            message: `Status "${status}" has not been updated in ${ageDays} day(s), relative to the corpus's latest "updated" date`,
            severity: 'warning',
          });
        }
      }
    }
  }

  // 4. Build result
  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  debug(`lint: ${records.length} files, ${errorCount} errors, ${warningCount} warnings`);

  return ok({
    diagnostics,
    fileCount: records.length,
    errorCount,
    warningCount,
  });
}
