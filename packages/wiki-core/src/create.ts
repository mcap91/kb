/**
 * Record creation module.
 *
 * Creates new wiki records for all manifest-driven types (WK, IN, DEC, SRC, AREA).
 * Rejects HO prefix with INVALID_PREFIX error.
 * Allocates IDs via allocate(), loads templates, fills frontmatter, writes files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { ok, fail, type Result } from './errors.js';
import type {
  CreateOpts,
  CreateResult,
  ManifestRecordType,
  WikiPrefix,
} from './types.js';
import { loadManifest } from './contract.js';
import { allocate } from './allocate.js';
import { debug, setVerbose } from './debug.js';
import {
  ensurePlanBundleSkeleton,
  getPlanBundleRelPath,
  getPlanDesignRelPath,
  getPlanExecutionRelPath,
} from './plan-bundle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the manifest record type definition that matches a given prefix or alias.
 */
function findTypeForPrefix(
  types: Record<string, ManifestRecordType>,
  prefix: string,
): { key: string; def: ManifestRecordType } | undefined {
  // First check by prefix field
  for (const [key, def] of Object.entries(types)) {
    if (def.prefix === prefix) {
      return { key, def };
    }
  }
  // Then check by alias (case-insensitive)
  const lower = prefix.toLowerCase();
  for (const [key, def] of Object.entries(types)) {
    if (def.aliases.some(a => a.toLowerCase() === lower)) {
      return { key, def };
    }
  }
  return undefined;
}

/**
 * Generate a slug from a title string.
 * Lowercases, replaces non-alphanumeric chars with hyphens, collapses runs, trims.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Read a template from the target repo's wiki/templates/ directory.
 */
function readTemplate(targetDir: string, templateName: string): Result<string> {
  const templatePath = path.join(targetDir, 'wiki', 'templates', templateName);

  if (!fs.existsSync(templatePath)) {
    return fail(
      'FILE_NOT_FOUND',
      `Template not found at ${templatePath} — was bootstrap run?`,
    );
  }

  try {
    const content = fs.readFileSync(templatePath, 'utf-8').replace(/\r\n/g, '\n');
    return ok(content);
  } catch (err) {
    return fail(
      'FILE_NOT_FOUND',
      `Failed to read template: ${String(err)}`,
      err,
    );
  }
}

/**
 * Fill template placeholders with actual values.
 * Replaces placeholders such as {{id}}, {{title}}, {{date}}, {{owner}}, {{slug}}.
 */
function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function getGitUserName(cwd: string): string | undefined {
  try {
    execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const name = execSync('git config user.name', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new wiki record.
 *
 * - Validates prefix against manifest
 * - Rejects HO prefix with INVALID_PREFIX
 * - Allocates ID (for allocated strategy) or derives slug (for slug strategy)
 * - Loads and fills template
 * - Writes record file to the correct directory
 * - Returns the created file path and ID
 */
export async function create(
  opts: CreateOpts,
): Promise<Result<CreateResult>> {
  if (opts.verbose) setVerbose(true);

  const prefix = opts.prefix.toUpperCase();

  debug(`create: prefix=${prefix}, title="${opts.title}", dir=${opts.dir}`);

  // 1. Explicit HO rejection
  if (prefix === 'HO') {
    return fail(
      'INVALID_PREFIX',
      'HO prefix is dispatch-owned and cannot be used with wiki create',
    );
  }

  // 2. Load manifest and find the type definition
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  // Check excluded prefixes
  if (manifest.excludedPrefixes.includes(prefix)) {
    return fail(
      'INVALID_PREFIX',
      `Prefix "${prefix}" is excluded from wiki record creation`,
    );
  }

  const typeMatch = findTypeForPrefix(manifest.types, prefix);
  if (!typeMatch) {
    return fail(
      'INVALID_PREFIX',
      `Prefix "${prefix}" is not defined in the manifest`,
    );
  }

  const { def: typeDef } = typeMatch;
  const targetDir = path.resolve(opts.dir);
  const now = new Date().toISOString();
  const dateOnly = now.slice(0, 10);
  const owner = opts.owner ?? getGitUserName(targetDir) ?? 'unassigned';

  // 3. Determine the ID and filename
  let id: string;
  let filename: string;

  if (typeDef.idStrategy === 'allocated') {
    // Use allocate() to get the next sequential ID
    const allocResult = await allocate({
      dir: opts.dir,
      prefix: typeDef.prefix as WikiPrefix,
      verbose: opts.verbose,
    });
    if (!allocResult.ok) {
      return allocResult;
    }
    id = allocResult.data.id;
    filename = `${id}.md`;
  } else {
    // Slug-based ID (AREA records)
    const slug = opts.slug || slugify(opts.title);
    if (!slug) {
      return fail(
        'INVALID_FIELD',
        'Could not derive a slug from the title — provide a slug explicitly',
      );
    }
    id = slug;
    filename = `${slug}.md`;
  }

  // 4. Load template from target repo
  const templateResult = readTemplate(targetDir, typeDef.template);
  if (!templateResult.ok) {
    return templateResult;
  }

  // 5. Fill template with values
  const values: Record<string, string> = {
    id,
    title: opts.title,
    date: dateOnly,
    owner,
    slug: typeDef.idStrategy === 'slug' ? id : '',
    bundle_path: typeDef.prefix === 'PLN' ? getPlanBundleRelPath(id) : '',
    design_entry: typeDef.prefix === 'PLN' ? getPlanDesignRelPath(id) : '',
    execution_entry: typeDef.prefix === 'PLN' ? getPlanExecutionRelPath(id) : '',
  };

  const content = fillTemplate(templateResult.data, values);

  // 6. Write the record file
  const recordDir = path.join(targetDir, typeDef.directory);
  const recordPath = path.join(recordDir, filename);

  // Ensure the directory exists
  if (!fs.existsSync(recordDir)) {
    fs.mkdirSync(recordDir, { recursive: true });
  }

  try {
    fs.writeFileSync(recordPath, content, 'utf-8');
  } catch (err) {
    return fail(
      'FILE_WRITE_ERROR',
      `Failed to write record file: ${String(err)}`,
      err,
    );
  }

  if (typeDef.prefix === 'PLN') {
    const bundleResult = ensurePlanBundleSkeleton(targetDir, id, now);
    if (!bundleResult.ok) {
      return fail(bundleResult.error, bundleResult.message, bundleResult.detail);
    }
  }

  const relativePath = path.relative(targetDir, recordPath).replace(/\\/g, '/');
  debug(`created record: ${relativePath}`);

  return ok({ id, path: relativePath });
}
