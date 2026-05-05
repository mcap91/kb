/**
 * CLI command implementations.
 *
 * Each command is a thin wrapper that parses command-specific arguments
 * and calls the corresponding wiki-core function.
 */

import {
  bootstrap,
  sync,
  allocate,
  create,
  lint,
  generate,
  buildSearchIndex,
  search,
  type WikiPrefix,
} from '@kb/wiki-core';
import { parseFlag, parseValue } from './run.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireDir(args: string[]): string {
  const dir = parseValue(args, '--dir');
  if (!dir) {
    console.error('Error: --dir <path> is required');
    process.exitCode = 1;
    throw new Error('missing --dir');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

export async function cmdBootstrap(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const repo = parseValue(args, '--repo');
  if (!repo) {
    console.error('Error: --repo <org/name> is required');
    process.exitCode = 1;
    return;
  }

  const dryRun = parseFlag(args, '--dry-run');
  const result = await bootstrap({ dir, repo, dryRun });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log('Dry run - would create:');
  } else {
    console.log('Bootstrap complete.');
  }
  console.log(`  Created: ${result.data.created.length} items`);
  console.log(`  Skipped: ${result.data.skipped.length} items`);
  for (const f of result.data.created) {
    console.log(`    + ${f}`);
  }
}

// ---------------------------------------------------------------------------
// sync-contract
// ---------------------------------------------------------------------------

export async function cmdSyncContract(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const check = parseFlag(args, '--check');
  const result = await sync({ dir, check });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  if (check) {
    console.log('Sync check:');
  } else {
    console.log('Sync complete.');
  }
  console.log(`  Synced:  ${result.data.synced.length}`);
  console.log(`  Drifted: ${result.data.drifted.length}`);
  console.log(`  Skipped: ${result.data.skipped.length}`);

  for (const f of result.data.drifted) {
    console.log(`  ! drift: ${f}`);
  }
}

// ---------------------------------------------------------------------------
// allocate-id
// ---------------------------------------------------------------------------

export async function cmdAllocateId(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const prefix = parseValue(args, '--prefix');
  if (!prefix) {
    console.error('Error: --prefix <PREFIX> is required');
    process.exitCode = 1;
    return;
  }

  const result = await allocate({ dir, prefix: prefix as WikiPrefix });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(result.data.id);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function cmdCreate(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const prefix = parseValue(args, '--prefix');
  if (!prefix) {
    console.error('Error: --prefix <PREFIX> is required');
    process.exitCode = 1;
    return;
  }

  const title = parseValue(args, '--title');
  if (!title) {
    console.error('Error: --title <title> is required');
    process.exitCode = 1;
    return;
  }

  const slug = parseValue(args, '--slug');

  const result = await create({ dir, prefix, title, slug });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Created: ${result.data.id}`);
  console.log(`Path:    ${result.data.path}`);
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

export async function cmdLint(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const result = await lint({ dir });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  const { diagnostics, fileCount, errorCount, warningCount } = result.data;

  for (const d of diagnostics) {
    const prefix = d.severity === 'error' ? 'ERROR' : 'WARN';
    const field = d.field ? ` [${d.field}]` : '';
    console.log(`  ${prefix}: ${d.file}${field} — ${d.code}: ${d.message}`);
  }

  console.log(`\nLinted ${fileCount} files: ${errorCount} errors, ${warningCount} warnings`);

  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

export async function cmdGenerate(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const result = await generate({ dir });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('Generated views:');
  for (const f of result.data.generated) {
    console.log(`  ${f}`);
  }
}

// ---------------------------------------------------------------------------
// build-search-index
// ---------------------------------------------------------------------------

export async function cmdBuildSearchIndex(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const result = await buildSearchIndex({ dir });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Indexed ${result.data.indexed} documents`);
  console.log(`Index:   ${result.data.path}`);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function cmdSearch(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const query = parseValue(args, '--query');
  if (!query) {
    console.error('Error: --query <query> is required');
    process.exitCode = 1;
    return;
  }

  const prefix = parseValue(args, '--prefix') as WikiPrefix | undefined;
  const status = parseValue(args, '--status');
  const limitStr = parseValue(args, '--limit');
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  const result = await search({ dir, query, prefix, status, limit });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Search: "${result.data.query}" — ${result.data.total} results`);
  for (const hit of result.data.hits) {
    const pfx = hit.prefix ? `[${hit.prefix}] ` : '';
    console.log(`  ${pfx}${hit.id} — ${hit.title} (score: ${hit.score.toFixed(2)})`);
    if (hit.snippet) {
      console.log(`    ${hit.snippet}`);
    }
  }
}
