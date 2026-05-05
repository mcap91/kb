/**
 * Sync contract templates into an already-bootstrapped consuming repo.
 *
 * - Syncs record templates from contract/templates/ into the target repo
 * - Reports drift on shared bootstrap surfaces (schema.md, conventions.md, index.md)
 * - Does NOT overwrite bootstrap surfaces — they are consumer-owned after bootstrap
 * - Updates wiki/.wiki-contract.json with lastSyncedAt timestamp
 * - Supports --check mode (report what would change without making changes)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  SyncOpts,
  SyncResult,
  WikiContractMetadata,
} from './types.js';
import {
  loadManifest,
  getRecordTemplates,
  bootstrapDir,
} from './contract.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bootstrap surfaces to check for drift (relative to wiki/). */
const BOOTSTRAP_SURFACES = ['schema.md', 'conventions.md', 'index.md'];

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Sync contract templates into a bootstrapped consuming repo.
 *
 * - `check` mode: report what would change without writing
 * - Normal mode: overwrite record templates and update contract metadata
 * - Bootstrap surfaces are never overwritten — only drift-reported
 */
export async function sync(opts: SyncOpts): Promise<Result<SyncResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');
  const checkOnly = opts.check ?? false;

  debug(`sync target: ${targetDir}`);
  debug(`check-only: ${checkOnly}`);

  // Verify the target is bootstrapped
  const contractPath = path.join(wikiDir, '.wiki-contract.json');
  if (!fs.existsSync(contractPath)) {
    return fail(
      'NOT_BOOTSTRAPPED',
      `Target does not appear to be bootstrapped — missing ${contractPath}`,
    );
  }

  // Load manifest
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }

  const synced: string[] = [];
  const drifted: string[] = [];
  const skipped: string[] = [];

  // 1. Sync record templates
  const templatesResult = getRecordTemplates();
  if (!templatesResult.ok) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read templates: ${templatesResult.message}`);
  }

  const templateDest = path.join(wikiDir, 'templates');
  if (!fs.existsSync(templateDest)) {
    if (!checkOnly) {
      fs.mkdirSync(templateDest, { recursive: true });
    }
  }

  for (const srcPath of templatesResult.data) {
    const filename = path.basename(srcPath);
    const destPath = path.join(templateDest, filename);
    const srcContent = fs.readFileSync(srcPath, 'utf-8');

    if (!fs.existsSync(destPath)) {
      // Template missing in target — needs sync
      if (!checkOnly) {
        fs.writeFileSync(destPath, srcContent, 'utf-8');
      }
      synced.push(path.relative(targetDir, destPath).replace(/\\/g, '/'));
      debug(`synced template: ${filename}`);
    } else {
      const destContent = fs.readFileSync(destPath, 'utf-8');
      if (srcContent !== destContent) {
        // Template has drifted — overwrite in normal mode
        if (!checkOnly) {
          fs.writeFileSync(destPath, srcContent, 'utf-8');
        }
        synced.push(path.relative(targetDir, destPath).replace(/\\/g, '/'));
        debug(`updated template: ${filename}`);
      } else {
        skipped.push(path.relative(targetDir, destPath).replace(/\\/g, '/'));
        debug(`skipped template (unchanged): ${filename}`);
      }
    }
  }

  // 2. Check drift on bootstrap surfaces (never overwrite)
  const bsDir = bootstrapDir();
  for (const surface of BOOTSTRAP_SURFACES) {
    const destPath = path.join(wikiDir, surface);
    const srcPath = path.join(bsDir, surface);

    if (!fs.existsSync(destPath) || !fs.existsSync(srcPath)) {
      continue;
    }

    const srcContent = fs.readFileSync(srcPath, 'utf-8');
    const destContent = fs.readFileSync(destPath, 'utf-8');

    if (srcContent !== destContent) {
      drifted.push(`wiki/${surface}`);
      debug(`drift detected: wiki/${surface}`);
    }
  }

  // 3. Update contract metadata with lastSyncedAt (unless check-only)
  if (!checkOnly) {
    try {
      const raw = fs.readFileSync(contractPath, 'utf-8');
      const meta = JSON.parse(raw) as WikiContractMetadata;
      meta.lastSyncedAt = new Date().toISOString();
      fs.writeFileSync(contractPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
      debug('updated .wiki-contract.json with lastSyncedAt');
    } catch (err) {
      return fail(
        'SYNC_ERROR',
        `Failed to update contract metadata: ${String(err)}`,
        err,
      );
    }
  }

  return ok({ synced, drifted, skipped });
}
