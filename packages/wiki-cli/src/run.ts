/**
 * CLI command dispatcher.
 *
 * Parses global flags (--verbose, --help, --version) and dispatches
 * to subcommand handlers.
 */

import { VERSION } from '@kb/wiki-core';
import { setVerbose } from '@kb/wiki-core';
import {
  cmdBootstrap,
  cmdSyncContract,
  cmdAllocateId,
  cmdCreate,
  cmdLint,
  cmdGenerate,
  cmdBuildSearchIndex,
  cmdSearch,
  cmdImportPlan,
  cmdValidatePlan,
  cmdArchivePlan,
} from './commands.js';

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

export function parseFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
kb wiki CLI v${VERSION}

Usage: npm run wiki -- <command> [options]

Commands:
  bootstrap            Bootstrap wiki directory in a consuming repo
  sync-contract        Sync contract templates into target repo
  allocate-id          Allocate a sequential ID for a record type
  create               Create a new wiki record
  lint                 Lint wiki records for frontmatter issues
  generate             Generate standard wiki views
  build-search-index   Build the search index
  search               Search wiki records and docs
  import-plan          Import artifacts into a PLN bundle
  validate-plan        Validate a PLN record and bundle
  archive-plan         Mark a PLN record done

Global options:
  --help               Show this help text
  --version            Show version number
  --verbose            Enable verbose/debug output
`.trim();

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  bootstrap: cmdBootstrap,
  'sync-contract': cmdSyncContract,
  'allocate-id': cmdAllocateId,
  create: cmdCreate,
  lint: cmdLint,
  generate: cmdGenerate,
  'build-search-index': cmdBuildSearchIndex,
  search: cmdSearch,
  'import-plan': cmdImportPlan,
  'validate-plan': cmdValidatePlan,
  'archive-plan': cmdArchivePlan,
};

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<void> {
  // Global flags
  if (parseFlag(args, '--help') || args.length === 0) {
    console.log(HELP);
    process.exitCode = 0;
    return;
  }

  if (parseFlag(args, '--version')) {
    console.log(VERSION);
    process.exitCode = 0;
    return;
  }

  if (parseFlag(args, '--verbose')) {
    setVerbose(true);
  }

  // First positional argument is the command
  const cmd = args[0];

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Run with --help to see available commands.`);
    process.exitCode = 1;
    return;
  }

  await handler(args.slice(1));
}
