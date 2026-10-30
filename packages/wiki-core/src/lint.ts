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
 *   - ORPHAN_WK                     — (error|warning, status-scoped, DEC-0036) WK record has no
 *                                     initiative; error for active/durable statuses, warning for
 *                                     inbox/parked, skipped for terminal
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
 *   - NESTED_FRONTMATTER            — (error, every record, WK-0211) a frontmatter line
 *                                     is indented and is not a plain `- item` list entry;
 *                                     such lines are silently dropped by kb's parsers
 *   - SLICES_TABLE_INVALID          — (error, WK, WK-0211) a WK's "## Slices" section is
 *                                     present but its table is malformed (header
 *                                     mismatch or a row with the wrong cell count)
 *   - SLICES_DUPLICATE_ROW_ID       — (error, WK, WK-0211) two "## Slices" rows share an id
 *   - SLICES_BROKEN_DEPENDS_ON      — (error, WK, WK-0211) a "## Slices" row's depends_on
 *                                     is not a row id in the same table
 *   - SLICES_INVALID_WRITE_SCOPE    — (error, WK, WK-0211) a "## Slices" row's write_scope
 *                                     entry contains a glob character
 *   - SLICES_INVALID_STATUS         — (error, WK, WK-0211) a "## Slices" row's status is
 *                                     not in the WK status enum
 *   - HARDENING_TABLE_INVALID       — (error, WK, WK-0212) a WK's "## Hardening" section
 *                                     is present but its table is malformed (header
 *                                     mismatch or a row with the wrong cell count)
 *   - HARDENING_INVALID_VALUE       — (error, WK, WK-0212) a "## Hardening" row's `check`
 *                                     or `verdict` cell is outside its closed value set,
 *                                     or `verdict` is `n/a` on a non-`override` row
 *   - HARDENING_EMPTY_OVERRIDE_NOTES — (error, WK, WK-0212) a "## Hardening" row with
 *                                     `check` = `override` has an empty `notes` cell
 *   - HARDENING_ROW_NUMBERING       — (error, WK, WK-0212) a "## Hardening" row's `#`
 *                                     cell is not an integer, or the column has a gap
 *                                     or duplicate across 1..n
 *   - RESOLUTIONS_TABLE_INVALID     — (error, WK, WK-0212) a WK's "## Resolutions"
 *                                     section is present but its table is malformed
 *                                     (header mismatch or a row with the wrong cell count)
 *   - RESOLUTIONS_INVALID_VALUE     — (error, WK, WK-0212) a "## Resolutions" row's
 *                                     `cold check` cell is outside its closed value set,
 *                                     or is `n/a` when `choice` is not `unresolved`
 *   - RESOLUTIONS_ROW_NUMBERING     — (error, WK, WK-0212) a "## Resolutions" row's `#`
 *                                     cell is not an integer, or the column has a gap
 *                                     or duplicate across 1..n
 *   - AC_MISSING                    — (error, WK, status-scoped, WK-0197/HO-0107) an
 *                                     open WK (todo/in_progress/review/blocked) has no
 *                                     "## Acceptance criteria" section, or the section
 *                                     has no checkbox-style criteria at all (only plain
 *                                     bullets or prose), or the section holds only the
 *                                     template placeholder `_criterion_` — three
 *                                     distinct messages, one per case
 *   - AC_UNVERIFIABLE               — (warning, WK, status-scoped, WK-0197/HO-0107) one
 *                                     diagnostic per acceptance-criterion (checkbox plus
 *                                     its indented continuation lines, if any), on an
 *                                     open WK, whose combined text names no verifiable
 *                                     check, and per `_criterion_` placeholder bullet
 *                                     that sits beside real criteria
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
import {
  frontmatterSchemas,
  workStatusSchema,
  hardeningCheckSchema,
  hardeningVerdictSchema,
  resolutionColdCheckSchema,
} from './schemas.js';
import { debug, setVerbose } from './debug.js';
import { buildDependencyProjection } from './deps.js';
import { readSlices, readHardening, readResolutions } from './body-table.js';

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
  /** Raw indented frontmatter lines (WK-0211 NESTED_FRONTMATTER) that `parseFrontmatter` silently dropped. */
  nestedFrontmatterLines: string[];
}

/**
 * Minimal YAML frontmatter parser.
 * Extracts content between leading `---` fences and parses key-value pairs.
 * Returns null if the file has no valid frontmatter fence.
 */
function parseFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string; yamlBlock: string } | null {
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

  return { data, body, yamlBlock };
}

// ---------------------------------------------------------------------------
// NESTED_FRONTMATTER (WK-0211)
// ---------------------------------------------------------------------------

/**
 * Find frontmatter lines that `parseFrontmatter`'s hand-rolled parser silently drops:
 * an indented line that is not a `- item` list entry (`^  ?- `), or a list entry
 * shaped `- key: value` (a nested map, e.g. under a list-of-maps). Plain scalar list
 * items (`  - WK-0001`) are fine; a nested mapping under any key is not — kb's
 * frontmatter parsers (and graph-explore's wiki-overlay, which `line.trim()`s before
 * key matching) don't understand nested YAML.
 */
function findNestedFrontmatterLines(yamlBlock: string): string[] {
  const violations: string[] = [];
  for (const line of yamlBlock.split('\n')) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) continue;

    const listItemMatch = /^  ?- (.*)$/.exec(line);
    if (!listItemMatch) {
      violations.push(line);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*:\s/.test(listItemMatch[1])) {
      violations.push(line);
    }
  }
  return violations;
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
 * Extract the raw (trimmed) lines of a record body's "## Acceptance criteria"
 * section — from that heading up to (but not including) the next `##`
 * heading, or EOF. Returns `null` if the section heading is absent entirely
 * (distinct from a present-but-empty section, which returns `[]`) — AC_MISSING
 * (WK-0197) needs that distinction.
 *
 * This is the single section reader shared by every Acceptance-criteria rule
 * (extractAcceptanceCriteriaCheckboxes, AC_MISSING, AC_UNVERIFIABLE) so the
 * heading-to-heading slicing logic isn't duplicated.
 */
function extractAcceptanceCriteriaSectionLines(body: string): string[] | null {
  const lines = body.split('\n');
  const headingIdx = lines.findIndex(line =>
    /^##\s+Acceptance criteria\s*$/i.test(line.trim()),
  );
  if (headingIdx === -1) return null;

  const sectionLines: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^##\s+/.test(trimmed)) break;
    sectionLines.push(trimmed);
  }
  return sectionLines;
}

/**
 * Extract the checkbox lines (`- [ ]` / `- [x]`) from a record body's
 * "## Acceptance criteria" section. Returns an empty array if the section is
 * absent or holds no checkbox lines.
 *
 * Scoping to this section only (rather than the whole body) is deliberate:
 * a stray open box under an unrelated `## Checklist` heading must not trip
 * AC_COMPLETE_STATUS_OPEN or the build-breaking UNCHECKED_CHECKLIST error.
 */
function extractAcceptanceCriteriaCheckboxes(body: string): string[] {
  const sectionLines = extractAcceptanceCriteriaSectionLines(body);
  if (sectionLines === null) return [];
  return sectionLines.filter(line => /^-\s*\[[ xX]\]/.test(line));
}

/** True if a checkbox line (as returned by extractAcceptanceCriteriaCheckboxes) is checked. */
function isCheckedBox(line: string): boolean {
  return /^-\s*\[[xX]\]/.test(line);
}

// ---------------------------------------------------------------------------
// AC_MISSING / AC_UNVERIFIABLE heuristic (WK-0197, revised HO-0107)
// ---------------------------------------------------------------------------

/**
 * Heading matcher for AC_MISSING / AC_UNVERIFIABLE only (HO-0107 F-heading): tolerates
 * trailing text after "## Acceptance criteria" (e.g. WK-0183's own heading,
 * "## Acceptance criteria (4 tiers, operator-ratified 2026-09-29)"). The shared
 * extractAcceptanceCriteriaSectionLines above requires an exact heading match and is
 * untouched by this — AC_COMPLETE_STATUS_OPEN and UNCHECKED_CHECKLIST keep requiring
 * an exact "## Acceptance criteria" heading.
 */
function isAcceptanceCriteriaHeadingWithSuffix(line: string): boolean {
  return /^##\s+Acceptance criteria\b/i.test(line.trim());
}

/**
 * Raw (un-trimmed) lines of the "## Acceptance criteria" section for AC_MISSING /
 * AC_UNVERIFIABLE only, tolerating a heading suffix (see above). Leading whitespace is
 * preserved (unlike extractAcceptanceCriteriaSectionLines) so groupAcCriteria can tell
 * a checkbox's indented continuation line from a new top-level bullet or heading.
 * Returns null when the heading itself is absent (distinct from an empty section).
 */
function extractAcceptanceCriteriaRawLines(body: string): string[] | null {
  const lines = body.split('\n');
  const headingIdx = lines.findIndex(isAcceptanceCriteriaHeadingWithSuffix);
  if (headingIdx === -1) return null;

  const sectionLines: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines;
}

/**
 * Group a "## Acceptance criteria" section's raw lines into one combined text per
 * checkbox criterion, folding in each checkbox's indented continuation lines — any
 * non-blank line that starts with whitespace and immediately follows, with no
 * intervening blank line or new bullet. Plain (non-checkbox) bullets and bare prose are
 * not criteria and contribute no entry — that is exactly AC_MISSING's "section present
 * but no checkbox criteria" case: a non-null section with a zero-length result here.
 */
function groupAcCriteria(rawLines: string[]): string[] {
  const criteria: string[] = [];
  let openIdx = -1;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();

    const checkboxMatch = /^-\s*\[[ xX]\]\s*(.*)$/.exec(trimmed);
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim());
      openIdx = criteria.length - 1;
      continue;
    }

    if (trimmed === '') {
      openIdx = -1;
      continue;
    }

    if (openIdx !== -1 && /^\s/.test(rawLine)) {
      criteria[openIdx] = `${criteria[openIdx]} ${trimmed}`.trim();
      continue;
    }

    // Plain bullet or prose: not a criterion, and does not extend one.
    openIdx = -1;
  }

  return criteria;
}

/**
 * Detection heuristic for "names a verifiable check" (WK-0197 delegates the exact
 * heuristic to implementation time; revised under HO-0107 F3). A criterion's combined
 * text counts as verifiable if it contains at least one of:
 *   - a repo-relative path: a slash-separated segment ending in a dotted extension
 *     (e.g. `packages/wiki-core/src/lint.ts`, `out/report.json`)
 *   - an npm/CLI invocation: `npm`, `npx`, `tsx`, `node`, `git`, or `curl` followed by
 *     an argument
 *   - a number with a unit or comparison (ms, s, sec, min, %, x, MB, GB, KB, or a
 *     `<`/`>`/`<=`/`>=`/`==` comparison against a number)
 *   - an explicit observable-behavior/predicate verb (returns, throws, logs, prints,
 *     outputs, produces, renders, emits, exit code, exits, responds with, displays,
 *     rejected/rejects, fires, flags)
 *   - a command-like token immediately followed by an outcome word (passes, succeeds,
 *     fails, exits [with code] 0, and their inflections) — a structural shape, not an
 *     enumerated tool vocabulary, so it covers any command/test name
 *   - a filename or path (with or without a slash, extension, or trailing `/`) near an
 *     existence/content predicate (exists, contains, unchanged, is generated)
 * Deterministic regex presence checks only — no controlled vocabulary, no semantic
 * inference, no proof compilation (WK-0197 Out). Inline code (backticks) alone is not a
 * signal — bare backticked text passes only when it also matches one of the shapes
 * above (a path, a command, a verb, etc.), never on backticks by themselves.
 */
const AC_VERIFIABLE_REPO_PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,10}\b/;
const AC_VERIFIABLE_CLI_COMMAND_RE = /\b(npm|npx|tsx|node|git|curl)\b\s+\S+/i;
const AC_VERIFIABLE_METRIC_RE =
  /\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|min|mins|minutes|%|x|MB|GB|KB)\b|[<>]=?\s*\d|==\s*\d/i;
const AC_VERIFIABLE_BEHAVIOR_VERB_RE =
  /\b(returns?|throws?|logs?|prints?|outputs?|produces?|renders?|emits?|exit code|exits?|responds with|displays?|rejected|rejects?|fires?|flags?)\b/i;
const AC_VERIFIABLE_OUTCOME_RE =
  /\b[\w'-]+\s+(passes|passed|pass|succeeds|succeeded|succeed|fails|failed|fail|exits?\s+(?:with\s+)?(?:code\s+)?0)\b/i;
const AC_VERIFIABLE_ARTIFACT_RE =
  /\b([\w.-]+\.[A-Za-z0-9]{1,10}|[\w.-]+\/)[^.?!]{0,30}?\b(exists?|contains?|unchanged|is\s+generated)\b/i;

function bulletNamesVerifiableCheck(text: string): boolean {
  return (
    AC_VERIFIABLE_REPO_PATH_RE.test(text) ||
    AC_VERIFIABLE_CLI_COMMAND_RE.test(text) ||
    AC_VERIFIABLE_METRIC_RE.test(text) ||
    AC_VERIFIABLE_BEHAVIOR_VERB_RE.test(text) ||
    AC_VERIFIABLE_OUTCOME_RE.test(text) ||
    AC_VERIFIABLE_ARTIFACT_RE.test(text)
  );
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

/**
 * Append-only check (v1, WK-0212 Scope) shared by "## Hardening" and "## Resolutions":
 * the `#` column must run 1..n, integers, no gaps, no duplicates. No git-history
 * comparison — editing a row in place or deleting+renumbering is undetected by design.
 */
function checkRowNumbering(
  diagnostics: LintDiagnostic[],
  relPath: string,
  heading: string,
  code: string,
  raws: string[],
): void {
  const seen = new Map<number, number>();
  let anyInvalid = false;

  for (const raw of raws) {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      diagnostics.push({
        file: relPath,
        code,
        message: `"#" column value "${raw}" in "## ${heading}" is not a positive integer`,
        severity: 'error',
      });
      anyInvalid = true;
      continue;
    }
    const num = Number(trimmed);
    seen.set(num, (seen.get(num) ?? 0) + 1);
  }

  for (const [num, count] of seen.entries()) {
    if (count > 1) {
      diagnostics.push({
        file: relPath,
        code,
        message: `"#" column has duplicate value "${num}" in "## ${heading}"`,
        severity: 'error',
      });
    }
  }

  if (!anyInvalid) {
    for (let i = 1; i <= raws.length; i++) {
      if (!seen.has(i)) {
        diagnostics.push({
          file: relPath,
          code,
          message: `"#" column is missing value ${i} (expected 1..${raws.length} with no gaps) in "## ${heading}"`,
          severity: 'error',
        });
      }
    }
  }
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
        nestedFrontmatterLines: parsed ? findNestedFrontmatterLines(parsed.yamlBlock) : [],
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
    // Rule: NESTED_FRONTMATTER — every record (WK-0211). Runs ahead of PARSE_ERROR
    // since a file can have well-fenced frontmatter that still contains lines the
    // hand-rolled parser above silently drops.
    for (const line of rec.nestedFrontmatterLines) {
      diagnostics.push({
        file: rec.relPath,
        code: 'NESTED_FRONTMATTER',
        message: `Nested frontmatter line is not a plain list item and would be silently dropped: "${line.trim()}"`,
        severity: 'error',
      });
    }

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

    // Rule: ORPHAN_WK — (error|warning, status-scoped, DEC-0036 — kb addition, not
    // upstream) a WK record with no initiative field at all. BROKEN_REFERENCE /
    // INVALID_INITIATIVE_TARGET only fire on a wrong reference, never an absent one.
    // Severity is scoped to status: active/durable statuses (todo, in_progress, review,
    // blocked, done) are an error — an orphan should not reach those statuses unnoticed.
    // inbox/parked are a warning — a loose idea not yet triaged is expected. Terminal-dead
    // statuses (cancelled, superseded, duplicate, wont_do, deprecated) are skipped
    // entirely — nothing to connect on a record that is never going anywhere.
    if (rec.typeDef.prefix === 'WK') {
      const val = fm['initiative'];
      if (val === undefined || val === null || val === '') {
        const status = typeof fm['status'] === 'string' ? fm['status'] : '';
        const errorStatuses = ['todo', 'in_progress', 'review', 'blocked', 'done'];
        const warningStatuses = ['inbox', 'parked'];
        // skip (no diagnostic): cancelled, superseded, duplicate, wont_do, deprecated

        let severity: 'error' | 'warning' | undefined;
        if (errorStatuses.includes(status)) {
          severity = 'error';
        } else if (warningStatuses.includes(status)) {
          severity = 'warning';
        }
        // else: terminal-dead statuses → skip, no diagnostic

        if (severity) {
          const wkId = typeof fm['id'] === 'string' ? fm['id'] : rec.relPath;
          diagnostics.push({
            file: rec.relPath,
            field: 'initiative',
            code: 'ORPHAN_WK',
            message: `${wkId} is ${status} with no initiative; set \`initiative: IN-####\` to connect it, or move to inbox/parked if it is a deliberate loose idea.`,
            severity,
          });
        }
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

    // Rule: AC_MISSING — (error, WK, status-scoped, WK-0197/HO-0107) an open WK (todo/
    // in_progress/review/blocked) has no "## Acceptance criteria" section, or the
    // section has no checkbox-style criteria at all (only plain bullets or prose, or
    // nothing), or the section holds only the template placeholder `_criterion_` (no
    // real criterion) — three distinct cases, three distinct messages.
    // Rule: AC_UNVERIFIABLE — (warning, WK, status-scoped, WK-0197/HO-0107) one
    // diagnostic per acceptance-criterion (a checkbox plus its indented continuation
    // lines, grouped by groupAcCriteria), on an open WK, whose combined text names no
    // verifiable check (see bulletNamesVerifiableCheck above), and per `_criterion_`
    // placeholder bullet that sits beside real criteria. Does not run when AC_MISSING
    // already fired for the record — a missing/empty/placeholder-only section has
    // nothing to shape-check. `blocked` is in scope (HO-0107 correction of HO-0105,
    // which wrongly exempted it against WK-0197's AC); inbox/parked/closed statuses
    // stay exempt as unscoped or already-terminal.
    if (rec.typeDef.prefix === 'WK') {
      const status = fm['status'];
      const AC_OPEN_STATUSES = ['todo', 'in_progress', 'review', 'blocked'];
      if (typeof status === 'string' && AC_OPEN_STATUSES.includes(status)) {
        const rawSectionLines = extractAcceptanceCriteriaRawLines(rec.body);

        if (rawSectionLines === null) {
          diagnostics.push({
            file: rec.relPath,
            code: 'AC_MISSING',
            message: 'No "## Acceptance criteria" section found',
            severity: 'error',
          });
        } else {
          const criteriaTexts = groupAcCriteria(rawSectionLines);

          if (criteriaTexts.length === 0) {
            diagnostics.push({
              file: rec.relPath,
              code: 'AC_MISSING',
              message:
                'The "## Acceptance criteria" section has no checkbox-style criteria (only plain bullets or prose, if anything)',
              severity: 'error',
            });
          } else {
            const realCriteria = criteriaTexts.filter(text => text !== '_criterion_');

            if (realCriteria.length === 0) {
              diagnostics.push({
                file: rec.relPath,
                code: 'AC_MISSING',
                message:
                  'The "## Acceptance criteria" section holds only the template placeholder "_criterion_"',
                severity: 'error',
              });
            } else {
              for (const text of criteriaTexts) {
                if (text === '_criterion_') {
                  diagnostics.push({
                    file: rec.relPath,
                    code: 'AC_UNVERIFIABLE',
                    message:
                      'Acceptance criterion is the unfilled template placeholder "_criterion_" alongside real criteria',
                    severity: 'warning',
                  });
                } else if (!bulletNamesVerifiableCheck(text)) {
                  diagnostics.push({
                    file: rec.relPath,
                    code: 'AC_UNVERIFIABLE',
                    message: `Acceptance criterion names no verifiable check (command, test, file/artifact path, metric, or observable behavior): "${text.slice(0, 120)}"`,
                    severity: 'warning',
                  });
                }
              }
            }
          }
        }
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

    // Rules: SLICES_* (WK-0211) — a WK's optional "## Slices" body table. No table is
    // the common case and `readSlices` returns `ok([])` for it, so these rules are a
    // no-op for the four in five WKs that never carry the section.
    if (rec.typeDef.prefix === 'WK') {
      const slicesResult = readSlices(rec.body);
      if (!slicesResult.ok) {
        diagnostics.push({
          file: rec.relPath,
          code: 'SLICES_TABLE_INVALID',
          message: slicesResult.message,
          severity: 'error',
        });
      } else if (slicesResult.data.length > 0) {
        const rows = slicesResult.data;
        const rowIds = new Set(rows.map(row => row.id));
        const seenIds = new Set<string>();

        for (const row of rows) {
          // Rule: SLICES_DUPLICATE_ROW_ID
          if (seenIds.has(row.id)) {
            diagnostics.push({
              file: rec.relPath,
              code: 'SLICES_DUPLICATE_ROW_ID',
              message: `Duplicate slice row id "${row.id}" in "## Slices"`,
              severity: 'error',
            });
          }
          seenIds.add(row.id);

          // Rule: SLICES_BROKEN_DEPENDS_ON
          for (const dep of row.depends_on) {
            if (!rowIds.has(dep)) {
              diagnostics.push({
                file: rec.relPath,
                code: 'SLICES_BROKEN_DEPENDS_ON',
                message: `Slice row "${row.id}" depends_on "${dep}", which is not a row id in "## Slices"`,
                severity: 'error',
              });
            }
          }

          // Rule: SLICES_INVALID_WRITE_SCOPE — literal paths only, no glob characters
          // (mirrors chassis's work-record-repository-path.mjs:45-57).
          for (const entry of row.write_scope) {
            if (/[*?[\]{}]/.test(entry)) {
              diagnostics.push({
                file: rec.relPath,
                code: 'SLICES_INVALID_WRITE_SCOPE',
                message: `Slice row "${row.id}" write_scope entry "${entry}" contains a glob character; write_scope must be literal paths`,
                severity: 'error',
              });
            }
          }

          // Rule: SLICES_INVALID_STATUS
          if (!workStatusSchema.options.includes(row.status as (typeof workStatusSchema.options)[number])) {
            diagnostics.push({
              file: rec.relPath,
              code: 'SLICES_INVALID_STATUS',
              message: `Slice row "${row.id}" status "${row.status}" is not a valid WK status`,
              severity: 'error',
            });
          }
        }
      }

      // Rules: HARDENING_* (WK-0212) — a WK's optional "## Hardening" body table. No
      // table is the common case and `readHardening` returns `ok([])` for it.
      const hardeningResult = readHardening(rec.body);
      if (!hardeningResult.ok) {
        diagnostics.push({
          file: rec.relPath,
          code: 'HARDENING_TABLE_INVALID',
          message: hardeningResult.message,
          severity: 'error',
        });
      } else if (hardeningResult.data.length > 0) {
        const rows = hardeningResult.data;

        checkRowNumbering(
          diagnostics,
          rec.relPath,
          'Hardening',
          'HARDENING_ROW_NUMBERING',
          rows.map(row => row.num),
        );

        for (const row of rows) {
          // Rule: HARDENING_INVALID_VALUE — `check`
          if (
            !hardeningCheckSchema.options.includes(
              row.check as (typeof hardeningCheckSchema.options)[number],
            )
          ) {
            diagnostics.push({
              file: rec.relPath,
              code: 'HARDENING_INVALID_VALUE',
              message: `Hardening row "${row.num}" check "${row.check}" is not one of: ${hardeningCheckSchema.options.join(' | ')}`,
              severity: 'error',
            });
          }

          // Rule: HARDENING_INVALID_VALUE — `verdict`
          if (
            !hardeningVerdictSchema.options.includes(
              row.verdict as (typeof hardeningVerdictSchema.options)[number],
            )
          ) {
            diagnostics.push({
              file: rec.relPath,
              code: 'HARDENING_INVALID_VALUE',
              message: `Hardening row "${row.num}" verdict "${row.verdict}" is not one of: ${hardeningVerdictSchema.options.join(' | ')}`,
              severity: 'error',
            });
          } else if (row.verdict === 'n/a' && row.check !== 'override') {
            diagnostics.push({
              file: rec.relPath,
              code: 'HARDENING_INVALID_VALUE',
              message: `Hardening row "${row.num}" verdict is "n/a" but check is "${row.check}"; "n/a" is only valid on "override" rows`,
              severity: 'error',
            });
          }

          // Rule: HARDENING_EMPTY_OVERRIDE_NOTES
          if (row.check === 'override' && row.notes.trim() === '') {
            diagnostics.push({
              file: rec.relPath,
              code: 'HARDENING_EMPTY_OVERRIDE_NOTES',
              message: `Hardening row "${row.num}" has check "override" but an empty "notes" cell; override rows must name the reason in notes`,
              severity: 'error',
            });
          }
        }
      }

      // Rules: RESOLUTIONS_* (WK-0212) — a WK's optional "## Resolutions" body table.
      // No table is the common case and `readResolutions` returns `ok([])` for it.
      const resolutionsResult = readResolutions(rec.body);
      if (!resolutionsResult.ok) {
        diagnostics.push({
          file: rec.relPath,
          code: 'RESOLUTIONS_TABLE_INVALID',
          message: resolutionsResult.message,
          severity: 'error',
        });
      } else if (resolutionsResult.data.length > 0) {
        const rows = resolutionsResult.data;

        checkRowNumbering(
          diagnostics,
          rec.relPath,
          'Resolutions',
          'RESOLUTIONS_ROW_NUMBERING',
          rows.map(row => row.num),
        );

        for (const row of rows) {
          // Rule: RESOLUTIONS_INVALID_VALUE — `cold check`
          if (
            !resolutionColdCheckSchema.options.includes(
              row.coldCheck as (typeof resolutionColdCheckSchema.options)[number],
            )
          ) {
            diagnostics.push({
              file: rec.relPath,
              code: 'RESOLUTIONS_INVALID_VALUE',
              message: `Resolutions row "${row.num}" cold check "${row.coldCheck}" is not one of: ${resolutionColdCheckSchema.options.join(' | ')}`,
              severity: 'error',
            });
          } else if (row.coldCheck === 'n/a' && row.choice !== 'unresolved') {
            diagnostics.push({
              file: rec.relPath,
              code: 'RESOLUTIONS_INVALID_VALUE',
              message: `Resolutions row "${row.num}" cold check is "n/a" but choice is "${row.choice}"; "n/a" is only valid when choice is "unresolved"`,
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
