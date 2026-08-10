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
  importPlan,
  validatePlan,
  archivePlan,
  computeValueReport,
  computeValueUsage,
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

function requireValue(args: string[], flag: string, label: string): string | undefined {
  const value = parseValue(args, flag);
  if (!value) {
    console.error(`Error: ${flag} <${label}> is required`);
    process.exitCode = 1;
    return undefined;
  }
  return value;
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
  const mcpClient = (parseValue(args, '--mcp-client') ?? 'claude') as 'claude' | 'codex' | 'none';
  const agentInstructions = !parseFlag(args, '--no-agent-instructions');
  const result = await bootstrap({ dir, repo, dryRun, mcpClient, agentInstructions });

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
  if (result.data.updated && result.data.updated.length > 0) {
    console.log(`  Updated: ${result.data.updated.length} items`);
    for (const f of result.data.updated) {
      console.log(`    ~ ${f}`);
    }
  }
  for (const f of result.data.created) {
    console.log(`    + ${f}`);
  }
  if (result.data.instructions) {
    for (const line of result.data.instructions) {
      console.log(`  > ${line}`);
    }
  }
}

// ---------------------------------------------------------------------------
// sync-contract
// ---------------------------------------------------------------------------

export async function cmdSyncContract(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const check = parseFlag(args, '--check');
  const mcpClient = (parseValue(args, '--mcp-client') ?? 'claude') as 'claude' | 'codex' | 'none';
  const agentInstructions = !parseFlag(args, '--no-agent-instructions');
  const adopt = parseValue(args, '--adopt');
  const result = await sync({ dir, check, mcpClient, agentInstructions, adopt });

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
  if (result.data.updated && result.data.updated.length > 0) {
    console.log(`  Updated: ${result.data.updated.length}`);
    for (const f of result.data.updated) {
      console.log(`    ~ ${f}`);
    }
  }

  if (result.data.adopted && result.data.adopted.length > 0) {
    console.log(`  Adopted: ${result.data.adopted.length}`);
    for (const f of result.data.adopted) {
      console.log(`    = adopted: ${f}`);
    }
  }
  for (const f of result.data.drifted) {
    console.log(`  ! drift: ${f}`);
  }
  if (result.data.instructions) {
    for (const line of result.data.instructions) {
      console.log(`  > ${line}`);
    }
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
  const owner = parseValue(args, '--owner') || undefined;

  const result = await create({ dir, prefix, title, slug, owner });

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

// ---------------------------------------------------------------------------
// import-plan
// ---------------------------------------------------------------------------

export async function cmdImportPlan(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const plan = requireValue(args, '--plan', 'PLN-id');
  if (!plan) return;

  const design = requireValue(args, '--design', 'path');
  if (!design) return;

  const execution = parseValue(args, '--execution');
  const sourceTool = parseValue(args, '--source-tool');
  const overwrite = parseFlag(args, '--overwrite');

  const result = await importPlan({ dir, plan, design, execution, sourceTool, overwrite });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Imported plan: ${result.data.plan}`);
  console.log(`Bundle:        ${result.data.bundlePath}`);
  console.log(`Design:        ${result.data.designEntry}`);
  console.log(`Execution:     ${result.data.executionEntry}`);
  console.log(`Sources:       ${result.data.sourceArtifacts.length}`);
}

// ---------------------------------------------------------------------------
// validate-plan
// ---------------------------------------------------------------------------

export async function cmdValidatePlan(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const plan = requireValue(args, '--plan', 'PLN-id');
  if (!plan) return;

  const result = await validatePlan({ dir, plan });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Plan:  ${result.data.plan}`);
  console.log(`Valid: ${result.data.valid}`);

  for (const issue of result.data.issues) {
    const issuePath = issue.path ? ` [${issue.path}]` : '';
    const tag = issue.severity === 'warning' ? 'warning' : 'error';
    console.log(`  ${tag}: ${issue.code}${issuePath}: ${issue.message}`);
  }

  if (!result.data.valid) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// archive-plan
// ---------------------------------------------------------------------------

export async function cmdArchivePlan(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const plan = requireValue(args, '--plan', 'PLN-id');
  if (!plan) return;

  const result = await archivePlan({ dir, plan });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Completed plan: ${result.data.plan}`);
  console.log(`Path:          ${result.data.path}`);
  console.log(`Completed:     ${result.data.completed}`);
}

// ---------------------------------------------------------------------------
// value-report
// ---------------------------------------------------------------------------

export async function cmdValueReport(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const since = parseValue(args, '--since');
  const untilRef = parseValue(args, '--until-ref');

  // Reject unknown/mistyped flags — a silently-dropped --untilRef (vs --until-ref) let the
  // report fall back to HEAD and cover the wrong span (WK-0053). No value token starts with
  // '--', so filtering '--'-prefixed args catches exactly the flags.
  const KNOWN_FLAGS = ['--dir', '--since', '--until-ref'];
  const unknown = args.filter(a => a.startsWith('--') && !KNOWN_FLAGS.includes(a));
  if (unknown.length > 0) {
    console.error(`Error: unknown flag(s) for value-report: ${unknown.join(', ')}. Known: ${KNOWN_FLAGS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const result = await computeValueReport({ dir, since, untilRef });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
}

// ---------------------------------------------------------------------------
// value-usage
// ---------------------------------------------------------------------------

export async function cmdValueUsage(args: string[]): Promise<void> {
  let dir: string;
  try { dir = requireDir(args); } catch { return; }

  const since = requireValue(args, '--since', 'YYYY-MM-DD');
  if (!since) return;

  const until = requireValue(args, '--until', 'YYYY-MM-DD');
  if (!until) return;

  const ccusageVersion = parseValue(args, '--ccusage-version');

  const result = await computeValueUsage({ dir, since, until, ccusageVersion });

  if (!result.ok) {
    console.error(`Error [${result.error}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
}
