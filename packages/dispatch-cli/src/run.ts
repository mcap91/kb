import { resolve, join } from 'node:path';
import { readFile, readdir, stat, access } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';

import {
  VERSION,
  ensureConfigDirs,
  generateKey,
  getConfigDir,
  getTokenDir,
  review,
  launch,
  cleanup,
} from '@kb/dispatch-core';

import type {
  AgentRegistry,
  CleanupReport,
  ReviewResult,
  RunResult,
} from '@kb/dispatch-core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_FILE = 'launchers.v1.json';
const KEY_FILE = 'token.key';

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

function getFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `
kb dispatch — reviewed multi-agent dispatch protocol

Usage:
  npm run dispatch -- <command> [options]

Commands:
  init-config                Initialize operator dispatch configuration
  review                     Review a handoff document
  launch                     Launch a reviewed handoff
  cleanup                    Clean up stale dispatch state
  status                     Show current dispatch state

Global Options:
  --help                     Show this help text
  --version                  Show version
  --verbose                  Enable verbose output

Command Options:
  init-config                (no additional options)

  review
    --dir <path>             Repository root directory (required)
    --handoff <rel-path>     Relative path to handoff file (required)
    --agent <name>           Agent name from registry (required)
    --reviewed-and-accept-risks  Explicit operator acknowledgment (required)

  launch
    --review-id <RV-uuid>   Review ID from review step (required)
    --dir <path>             Repository root directory (required)

  cleanup
    --dir <path>             Repository root directory (defaults to cwd)

  status
    --dir <path>             Repository root directory (defaults to cwd)
`.trim();

// ---------------------------------------------------------------------------
// Command: init-config
// ---------------------------------------------------------------------------

async function cmdInitConfig(args: string[], verbose: boolean): Promise<number> {
  if (verbose) console.log('[dispatch] Initializing configuration...');

  // 1. Create config directory structure
  const configDir = await ensureConfigDirs();
  console.log(`Config directory: ${configDir}`);

  // 2. Generate HMAC key if not present
  const keyPath = join(configDir, KEY_FILE);
  let keyExists = false;
  try {
    await access(keyPath);
    keyExists = true;
  } catch {
    // does not exist
  }

  if (keyExists) {
    console.log(`HMAC key already exists: ${keyPath}`);
  } else {
    const generatedPath = await generateKey();
    console.log(`HMAC key generated: ${generatedPath}`);
  }

  // 3. Write default registry if not present
  const registryPath = join(configDir, REGISTRY_FILE);
  let registryExists = false;
  try {
    await access(registryPath);
    registryExists = true;
  } catch {
    // does not exist
  }

  if (registryExists) {
    console.log(`Registry already exists: ${registryPath}`);
    console.log('  (not overwriting — delete and re-run to reset)');
  } else {
    const defaultRegistry: AgentRegistry = {
      version: 1,
      agents: {
        claude: {
          command: 'claude',
          args: ['-p', 'You are operating via the kb dispatch protocol. Read the handoff at $AGENT_BLACKBOARD_HANDOFF_PATH and write your response to $AGENT_BLACKBOARD_RESPONSE_PATH.'],
          description: 'Claude Code CLI (placeholder — configure with your Claude CLI path)',
        },
        codex: {
          command: 'codex',
          args: ['--approval-mode', 'full-auto'],
          description: 'Codex CLI (placeholder — configure with your Codex CLI path)',
        },
        'fake-agent': {
          command: 'npx',
          args: ['tsx', 'tests/fixtures/fake-agent.ts'],
          description: 'Deterministic test agent for dogfooding and CI',
        },
      },
    };

    await writeFile(registryPath, JSON.stringify(defaultRegistry, null, 2));
    console.log(`Default registry written: ${registryPath}`);
    console.log('  Agents: claude, codex, fake-agent');
  }

  console.log('\nInit complete. You can now review and launch handoffs.');
  return 0;
}

// ---------------------------------------------------------------------------
// Command: review
// ---------------------------------------------------------------------------

async function cmdReview(args: string[], verbose: boolean): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const handoff = getFlagValue(args, '--handoff');
  const agent = getFlagValue(args, '--agent');
  const accepted = getFlag(args, '--reviewed-and-accept-risks');

  if (!dir) {
    console.error('Error: --dir <path> is required');
    return 1;
  }
  if (!handoff) {
    console.error('Error: --handoff <relative-path> is required');
    return 1;
  }
  if (!agent) {
    console.error('Error: --agent <agent-name> is required');
    return 1;
  }
  if (!accepted) {
    console.error('Error: --reviewed-and-accept-risks flag is required');
    console.error('  This flag confirms you have read and reviewed the handoff document.');
    return 1;
  }

  if (verbose) {
    console.log(`[dispatch] Reviewing handoff: ${handoff}`);
    console.log(`[dispatch] Agent: ${agent}`);
    console.log(`[dispatch] Dir: ${resolve(dir)}`);
  }

  const result = await review({
    dir,
    handoff,
    agent,
    reviewedAndAcceptRisks: true,
    verbose,
  });

  if (!result.ok) {
    console.error(`Review failed: [${result.error}] ${result.message}`);
    if (verbose && result.detail) {
      console.error('Detail:', result.detail);
    }
    return 1;
  }

  const data: ReviewResult = result.data;
  console.log('Review succeeded.');
  console.log(`  Review ID: ${data.reviewId}`);
  console.log(`  Handoff:   ${data.handoffId}`);
  console.log(`  Agent:     ${data.agent}`);
  console.log(`  Mode:      ${data.mode}`);
  console.log(`  Bundle:    ${data.bundlePath}`);
  console.log(`  Token:     ${data.tokenPath}`);
  console.log(`  Expires:   ${data.expiry}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Command: launch
// ---------------------------------------------------------------------------

async function cmdLaunch(args: string[], verbose: boolean): Promise<number> {
  const reviewId = getFlagValue(args, '--review-id');
  const dir = getFlagValue(args, '--dir');

  if (!reviewId) {
    console.error('Error: --review-id <RV-uuid> is required');
    return 1;
  }
  if (!dir) {
    console.error('Error: --dir <path> is required');
    return 1;
  }

  if (verbose) {
    console.log(`[dispatch] Launching review: ${reviewId}`);
    console.log(`[dispatch] Dir: ${resolve(dir)}`);
  }

  const result = await launch({
    reviewId,
    dir,
    verbose,
  });

  if (!result.ok) {
    console.error(`Launch failed: [${result.error}] ${result.message}`);
    if (verbose && result.detail) {
      console.error('Detail:', result.detail);
    }
    return 1;
  }

  const data: RunResult = result.data;
  console.log('Launch succeeded.');
  console.log(`  Run ID:    ${data.runId}`);
  console.log(`  Review ID: ${data.reviewId}`);
  console.log(`  Handoff:   ${data.handoffId}`);
  console.log(`  Agent:     ${data.agent}`);
  console.log(`  Mode:      ${data.mode}`);
  console.log(`  Exit code: ${data.exitCode}`);
  console.log(`  Run dir:   ${data.runDir}`);
  console.log(`  Started:   ${data.startedAt}`);
  console.log(`  Completed: ${data.completedAt}`);
  if (data.response) {
    const summary = data.response.length > 200
      ? data.response.slice(0, 200) + '...'
      : data.response;
    console.log(`  Response:\n${summary}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Command: cleanup
// ---------------------------------------------------------------------------

async function cmdCleanup(args: string[], verbose: boolean): Promise<number> {
  const dir = getFlagValue(args, '--dir') ?? process.cwd();

  if (verbose) {
    console.log(`[dispatch] Running cleanup...`);
    console.log(`[dispatch] Dir: ${resolve(dir)}`);
  }

  const result = await cleanup({ dir, verbose });

  if (!result.ok) {
    console.error(`Cleanup failed: [${result.error}] ${result.message}`);
    if (verbose && result.detail) {
      console.error('Detail:', result.detail);
    }
    return 1;
  }

  const report: CleanupReport = result.data;
  console.log('Cleanup complete.');
  console.log(`  Orphan reviews removed:   ${report.orphanReviews.length}`);
  console.log(`  Orphan runs removed:      ${report.orphanRuns.length}`);
  console.log(`  Stale tokens recovered:   ${report.staleTokens.length}`);
  console.log(`  Expired tokens removed:   ${report.expiredTokens.length}`);
  console.log(`  Total removed:            ${report.totalRemoved}`);

  if (verbose && report.totalRemoved > 0) {
    if (report.orphanReviews.length > 0) {
      console.log('\n  Orphan reviews:');
      for (const id of report.orphanReviews) {
        console.log(`    - ${id}`);
      }
    }
    if (report.orphanRuns.length > 0) {
      console.log('\n  Orphan runs:');
      for (const id of report.orphanRuns) {
        console.log(`    - ${id}`);
      }
    }
    if (report.staleTokens.length > 0) {
      console.log('\n  Stale tokens:');
      for (const id of report.staleTokens) {
        console.log(`    - ${id}`);
      }
    }
    if (report.expiredTokens.length > 0) {
      console.log('\n  Expired tokens:');
      for (const id of report.expiredTokens) {
        console.log(`    - ${id}`);
      }
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

interface TokenInfo {
  reviewId: string;
  handoffId: string;
  agent: string;
  mode: string;
  expiry: string;
}

async function listTokensInState(state: string): Promise<TokenInfo[]> {
  const dir = getTokenDir(state as 'pending' | 'launching' | 'consumed' | 'rejected');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const tokens: TokenInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      const token = JSON.parse(raw);
      tokens.push({
        reviewId: token.payload?.reviewId ?? entry.replace(/\.json$/, ''),
        handoffId: token.payload?.handoffId ?? 'unknown',
        agent: token.payload?.agent ?? 'unknown',
        mode: token.payload?.mode ?? 'unknown',
        expiry: token.payload?.expiry ?? 'unknown',
      });
    } catch {
      // Skip malformed token files
    }
  }

  return tokens;
}

async function cmdStatus(args: string[], verbose: boolean): Promise<number> {
  const dir = getFlagValue(args, '--dir') ?? process.cwd();
  const resolvedDir = resolve(dir);

  console.log(`Dispatch status for: ${resolvedDir}\n`);

  // 1. List pending reviews
  const pendingTokens = await listTokensInState('pending');
  console.log(`Pending reviews: ${pendingTokens.length}`);
  if (pendingTokens.length > 0) {
    for (const t of pendingTokens) {
      console.log(`  - ${t.reviewId} (${t.handoffId}, agent: ${t.agent}, mode: ${t.mode})`);
      if (verbose) console.log(`    expires: ${t.expiry}`);
    }
  }

  // 2. List launching (active)
  const launchingTokens = await listTokensInState('launching');
  console.log(`Active launches: ${launchingTokens.length}`);
  if (launchingTokens.length > 0) {
    for (const t of launchingTokens) {
      console.log(`  - ${t.reviewId} (${t.handoffId}, agent: ${t.agent})`);
    }
  }

  // 3. List consumed (recent completed)
  const consumedTokens = await listTokensInState('consumed');
  console.log(`Consumed tokens: ${consumedTokens.length}`);
  if (verbose && consumedTokens.length > 0) {
    for (const t of consumedTokens) {
      console.log(`  - ${t.reviewId} (${t.handoffId}, agent: ${t.agent})`);
    }
  }

  // 4. List rejected
  const rejectedTokens = await listTokensInState('rejected');
  console.log(`Rejected tokens: ${rejectedTokens.length}`);
  if (verbose && rejectedTokens.length > 0) {
    for (const t of rejectedTokens) {
      console.log(`  - ${t.reviewId} (${t.handoffId}, agent: ${t.agent})`);
    }
  }

  // 5. List recent runs in the repo
  const runsDir = join(resolvedDir, '.agent-runs', 'runs');
  let runCount = 0;
  try {
    const handoffDirs = await readdir(runsDir);
    for (const handoffId of handoffDirs) {
      const handoffPath = join(runsDir, handoffId);
      try {
        const runs = await readdir(handoffPath);
        runCount += runs.length;
        if (verbose) {
          for (const runId of runs) {
            console.log(`  Run: ${handoffId}/${runId}`);
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // .agent-runs/runs/ may not exist
  }

  console.log(`\nRuns in repo: ${runCount}`);

  // 6. List pending review bundles
  const reviewsDir = join(resolvedDir, '.agent-runs', 'reviews');
  let reviewCount = 0;
  try {
    const reviews = await readdir(reviewsDir);
    reviewCount = reviews.length;
  } catch {
    // .agent-runs/reviews/ may not exist
  }

  console.log(`Review bundles in repo: ${reviewCount}`);

  // Summary
  console.log('\nToken state summary:');
  console.log(`  pending:   ${pendingTokens.length}`);
  console.log(`  launching: ${launchingTokens.length}`);
  console.log(`  consumed:  ${consumedTokens.length}`);
  console.log(`  rejected:  ${rejectedTokens.length}`);

  return 0;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<number> {
  // Parse global flags
  const verbose = getFlag(args, '--verbose');
  const showHelp = getFlag(args, '--help') || getFlag(args, '-h');
  const showVersion = getFlag(args, '--version') || getFlag(args, '-v');

  // --version takes precedence
  if (showVersion) {
    console.log(`kb dispatch v${VERSION}`);
    return 0;
  }

  // Find the command (first non-flag argument)
  const command = args.find((a) => !a.startsWith('-'));

  // --help or no command
  if (showHelp || !command) {
    console.log(HELP_TEXT);
    return 0;
  }

  // Dispatch to command handler
  switch (command) {
    case 'init-config':
      return cmdInitConfig(args, verbose);
    case 'review':
      return cmdReview(args, verbose);
    case 'launch':
      return cmdLaunch(args, verbose);
    case 'cleanup':
      return cmdCleanup(args, verbose);
    case 'status':
      return cmdStatus(args, verbose);
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help to see available commands.');
      return 1;
  }
}
