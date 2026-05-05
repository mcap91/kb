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
 *   - PARSE_ERROR          — YAML frontmatter cannot be parsed
 *   - MISSING_FIELD        — required frontmatter field absent
 *   - INVALID_ENUM         — field value not in manifest enum set
 *   - DUPLICATE_ID         — multiple records share the same ID
 *   - BROKEN_REFERENCE     — depends_on / blocks / related / area / initiative
 *                            points to a nonexistent record
 *   - UNCHECKED_CHECKLIST  — (warning) closed/done record has unchecked items
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
  const trimmed = raw.replace(/^﻿/, ''); // strip BOM
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

    // Rule: UNCHECKED_CHECKLIST — warn on closed/done records with unchecked items
    const status = fm['status'];
    const closedStatuses = ['closed', 'done'];
    if (typeof status === 'string' && closedStatuses.includes(status)) {
      if (rec.body.includes('- [ ]')) {
        diagnostics.push({
          file: rec.relPath,
          code: 'UNCHECKED_CHECKLIST',
          message: 'Record is marked as closed/done but has unchecked checklist items',
          severity: 'warning',
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
