/**
 * Bootstrap a consuming repo's wiki directory.
 *
 * Creates the standard directory structure, writes metadata files,
 * copies bootstrap surfaces and record templates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  BootstrapOpts,
  BootstrapResult,
  WikiContractMetadata,
  IdState,
} from './types.js';
import {
  loadManifest,
  getBootstrapTemplates,
  getRecordTemplates,
} from './contract.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wiki directories to create (manifest-driven + handoffs). */
const WIKI_DIRS = [
  'wiki/issues',
  'wiki/initiatives',
  'wiki/decisions',
  'wiki/sources',
  'wiki/areas',
  'wiki/handoffs',
];

/**
 * Bootstrap surface files — these are only written if absent.
 * Map of destination (relative to wiki/) to source filename in contract/bootstrap/.
 */
const BOOTSTRAP_SURFACES: Record<string, string> = {
  'schema.md': 'schema.md',
  'conventions.md': 'conventions.md',
  'index.md': 'index.md',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists, creating it recursively if needed. */
function ensureDir(dirPath: string, dryRun: boolean, created: string[]): void {
  if (!fs.existsSync(dirPath)) {
    if (!dryRun) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    created.push(dirPath);
    debug(`created directory: ${dirPath}`);
  }
}

/** Write a file only if it does not already exist. Returns true if written. */
function writeIfAbsent(
  filePath: string,
  content: string,
  dryRun: boolean,
  created: string[],
  skipped: string[],
): boolean {
  if (fs.existsSync(filePath)) {
    skipped.push(filePath);
    debug(`skipped (exists): ${filePath}`);
    return false;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  created.push(filePath);
  debug(`wrote: ${filePath}`);
  return true;
}

/** Write a file unconditionally (metadata files). */
function writeFile(
  filePath: string,
  content: string,
  dryRun: boolean,
  created: string[],
): void {
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  created.push(filePath);
  debug(`wrote: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstrap a consuming repo's wiki directory structure.
 *
 * - Creates standard directories (including wiki/handoffs/)
 * - Writes wiki/.wiki-contract.json and wiki/.id-state.json
 * - Copies bootstrap surfaces (schema.md, conventions.md, index.md) only if absent
 * - Copies record templates (including handoff.md)
 * - Preserves existing docs/, AGENTS.md, CLAUDE.md
 * - Supports --dry-run
 */
export async function bootstrap(
  opts: BootstrapOpts,
): Promise<Result<BootstrapResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');
  const dryRun = opts.dryRun ?? false;

  debug(`bootstrap target: ${targetDir}`);
  debug(`dry-run: ${dryRun}`);

  // Load manifest to get contract version
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  const created: string[] = [];
  const skipped: string[] = [];

  // 1. Create wiki directories
  for (const rel of WIKI_DIRS) {
    const abs = path.join(targetDir, rel);
    ensureDir(abs, dryRun, created);
  }

  // 2. Write metadata files (always overwrite)
  const contractMeta: WikiContractMetadata = {
    contractVersion: manifest.contractVersion,
    repo: opts.repo,
    bootstrappedAt: new Date().toISOString(),
  };
  writeFile(
    path.join(wikiDir, '.wiki-contract.json'),
    JSON.stringify(contractMeta, null, 2) + '\n',
    dryRun,
    created,
  );

  // Build initial IdState from manifest: one entry per prefix-based type
  const idState: IdState = {};
  for (const [, typeDef] of Object.entries(manifest.types)) {
    if (typeDef.prefix && typeDef.stateKey) {
      idState[typeDef.prefix] = { next: 1, allocated: [] };
    }
  }
  writeFile(
    path.join(wikiDir, '.id-state.json'),
    JSON.stringify(idState, null, 2) + '\n',
    dryRun,
    created,
  );

  // 3. Copy bootstrap surfaces (only if absent)
  const bootstrapResult = getBootstrapTemplates();
  if (bootstrapResult.ok) {
    for (const [destName, srcName] of Object.entries(BOOTSTRAP_SURFACES)) {
      const srcPath = bootstrapResult.data.find(p => path.basename(p) === srcName);
      if (srcPath) {
        const destPath = path.join(wikiDir, destName);
        const content = fs.readFileSync(srcPath, 'utf-8');
        writeIfAbsent(destPath, content, dryRun, created, skipped);
      }
    }
  }

  // 4. Copy record templates (including handoff.md)
  const templatesResult = getRecordTemplates();
  if (templatesResult.ok) {
    // Determine template target directory
    const templateDest = path.join(wikiDir, 'templates');
    ensureDir(templateDest, dryRun, created);

    for (const srcPath of templatesResult.data) {
      const filename = path.basename(srcPath);
      const destPath = path.join(templateDest, filename);
      const content = fs.readFileSync(srcPath, 'utf-8');
      writeIfAbsent(destPath, content, dryRun, created, skipped);
    }
  }

  // Normalize paths to use forward slashes for consistency
  const normalize = (p: string): string => path.relative(targetDir, p).replace(/\\/g, '/');

  return ok({
    created: created.map(normalize),
    skipped: skipped.map(normalize),
  });
}
