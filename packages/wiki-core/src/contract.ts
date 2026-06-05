/**
 * Contract resolution module.
 *
 * Locates the kb repo root (where contract/ lives) and provides helpers
 * to load the manifest, list bootstrap templates, list record templates,
 * and read individual templates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ok, type Result } from './errors.js';
import type { WikiManifest } from './types.js';
import { debug } from './debug.js';

// ---------------------------------------------------------------------------
// Repo root resolution
// ---------------------------------------------------------------------------

/** Directory containing this source file. */
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find the kb repo root — the directory that contains `contract/manifest.json`.
 *
 * Walks upward from the location of this source file, which is always inside
 * the kb repo at `packages/wiki-core/src/`.
 */
export function findKbRoot(): string {
  // Start from this file's directory and walk up.
  let dir = path.resolve(THIS_DIR);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, 'contract', 'manifest.json');
    if (fs.existsSync(candidate)) {
      debug(`kb root resolved: ${dir}`);
      return dir;
    }
    dir = path.dirname(dir);
  }

  // Fallback: three levels up from packages/wiki-core/src/
  const fallback = path.resolve(THIS_DIR, '..', '..', '..');
  debug(`kb root fallback: ${fallback}`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve a path inside the contract directory. */
export function contractPath(...segments: string[]): string {
  return path.join(findKbRoot(), 'contract', ...segments);
}

/** Path to the manifest file. */
export function manifestPath(): string {
  return contractPath('manifest.json');
}

/** Path to the bootstrap templates directory. */
export function bootstrapDir(): string {
  return contractPath('bootstrap');
}

/** Path to the record templates directory. */
export function templatesDir(): string {
  return contractPath('templates');
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Load and parse `contract/manifest.json`.
 */
export function loadManifest(): Result<WikiManifest> {
  const mp = manifestPath();
  debug(`loading manifest from ${mp}`);

  if (!fs.existsSync(mp)) {
    return fail('CONTRACT_NOT_FOUND', `Manifest not found at ${mp}`);
  }

  try {
    const raw = fs.readFileSync(mp, 'utf-8');
    const parsed = JSON.parse(raw) as WikiManifest;
    return ok(parsed);
  } catch (err) {
    return fail('MANIFEST_ERROR', `Failed to parse manifest: ${String(err)}`, err);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap template helpers
// ---------------------------------------------------------------------------

/**
 * List bootstrap template file paths (files inside contract/bootstrap/).
 */
export function getBootstrapTemplates(): Result<string[]> {
  const dir = bootstrapDir();

  if (!fs.existsSync(dir)) {
    return fail('CONTRACT_NOT_FOUND', `Bootstrap directory not found at ${dir}`);
  }

  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const paths = entries.map(f => path.join(dir, f));
    debug(`bootstrap templates: ${paths.join(', ')}`);
    return ok(paths);
  } catch (err) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read bootstrap directory: ${String(err)}`, err);
  }
}

// ---------------------------------------------------------------------------
// Record template helpers
// ---------------------------------------------------------------------------

/**
 * List record template file paths (files inside contract/templates/).
 */
export function getRecordTemplates(): Result<string[]> {
  const dir = templatesDir();

  if (!fs.existsSync(dir)) {
    return fail('CONTRACT_NOT_FOUND', `Templates directory not found at ${dir}`);
  }

  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const paths = entries.map(f => path.join(dir, f));
    debug(`record templates: ${paths.join(', ')}`);
    return ok(paths);
  } catch (err) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read templates directory: ${String(err)}`, err);
  }
}

/**
 * Read the agent-instructions template from contract/agent-instructions.md.
 */
export function getAgentInstructionsTemplate(): Result<string> {
  const tp = path.join(findKbRoot(), 'contract', 'agent-instructions.md');
  debug(`reading agent instructions template from ${tp}`);

  if (!fs.existsSync(tp)) {
    return fail('FILE_NOT_FOUND', `Agent instructions template not found at ${tp}`);
  }

  try {
    const content = fs.readFileSync(tp, 'utf-8');
    return ok(content);
  } catch (err) {
    return fail('FILE_NOT_FOUND', `Failed to read agent instructions template: ${String(err)}`, err);
  }
}

/**
 * Read a specific template by filename (e.g. `"issue.md"` or `"handoff.md"`).
 */
export function getTemplate(name: string): Result<string> {
  const tp = path.join(templatesDir(), name);

  if (!fs.existsSync(tp)) {
    return fail('FILE_NOT_FOUND', `Template not found: ${tp}`);
  }

  try {
    const content = fs.readFileSync(tp, 'utf-8');
    return ok(content);
  } catch (err) {
    return fail('FILE_NOT_FOUND', `Failed to read template ${name}: ${String(err)}`, err);
  }
}
