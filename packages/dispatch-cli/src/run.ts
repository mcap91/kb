import { join, resolve } from 'node:path';

import {
  VERSION,
  cleanup,
  createHandoff,
  initConfig,
  launch,
  review,
  reviewAndLaunch,
  status,
} from '@kb/dispatch-core';

import type {
  CleanupReport,
  CreateHandoffResult,
  ReviewResult,
  RunResult,
  StatusResult,
} from '@kb/dispatch-core';

function getFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isLaunchFailureDetail(value: unknown): value is {
  runId?: string;
  runDir?: string;
  status?: string;
  responsePath?: string;
  metaPath?: string;
} {
  return typeof value === 'object' && value !== null;
}

const HELP_TEXT = `
kb dispatch — reviewed multi-agent dispatch protocol

Usage:
  npm run dispatch -- <command> [options]

Commands:
  init-config                Initialize operator dispatch configuration
  create-handoff             Create a repo-local HO handoff
  review                     Review a handoff document
  launch                     Launch a reviewed handoff
  review-and-launch          Review and immediately launch a handoff
  cleanup                    Clean up stale dispatch state
  status                     Show current dispatch state

Global Options:
  --help                     Show this help text
  --version                  Show version
  --verbose                  Enable verbose output

Command Options:
  init-config
    --force                  Overwrite the existing launcher registry

  create-handoff
    --dir <path>             Repository root directory (required)
    --title <text>           Handoff title (required)
    --subject <text>         Handoff subject (required)
    --allowed-agents <csv>   Allowed agents, comma-separated (required)
    --mode <mode>            implement | code_review | redteam (required)
    --work-item <WK-id>      Optional linked work item
    --write-scope <csv>      Optional write scope paths
    --read-first <csv>       Optional Read First paths
    --objective <text>       Optional objective section
    --constraints <csv>      Optional constraint bullets
    --expected-output <text> Optional expected output section
    --context <text>         Optional context section

  review
    --dir <path>             Repository root directory (required)
    --handoff <rel-path>     Relative path to handoff file (required)
    --agent <name>           Agent name from registry (required)
    --reviewed-and-accept-risks  Explicit operator acknowledgment (required)

  launch
    --review-id <RV-uuid>    Review ID from review step (required)
    --dir <path>             Repository root directory (required)
    --json                   Print machine-readable artifact paths

  review-and-launch
    --dir <path>             Repository root directory (required)
    --handoff <rel-path>     Relative path to handoff file (required)
    --agent <name>           Agent name from registry (required)
    --reviewed-and-accept-risks  Explicit operator acknowledgment (required)

  cleanup
    --dir <path>             Repository root directory (defaults to cwd)

  status
    --dir <path>             Repository root directory (defaults to cwd)
`.trim();

async function cmdInitConfig(args: string[]): Promise<number> {
  const force = getFlag(args, '--force');
  const result = await initConfig(force);
  if (!result.ok) {
    console.error(`Init failed: [${result.error}] ${result.message}`);
    return 1;
  }

  console.log(`Config directory: ${result.data.configDir}`);
  console.log(`HMAC key: ${result.data.keyPath}`);
  console.log(`Registry: ${result.data.registryPath}`);
  console.log(`Key created: ${result.data.keyCreated ? 'yes' : 'no'}`);
  console.log(`Registry created: ${result.data.registryCreated ? 'yes' : 'no'}`);
  return 0;
}

async function cmdCreateHandoff(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const title = getFlagValue(args, '--title');
  const subject = getFlagValue(args, '--subject');
  const allowedAgents = parseCsv(getFlagValue(args, '--allowed-agents'));
  const mode = getFlagValue(args, '--mode');

  if (!dir || !title || !subject || !mode || allowedAgents.length === 0) {
    console.error('Error: --dir, --title, --subject, --allowed-agents, and --mode are required');
    return 1;
  }

  const result = await createHandoff({
    dir,
    title,
    subject,
    allowed_agents: allowedAgents,
    mode: mode as 'implement' | 'code_review' | 'redteam',
    work_item: getFlagValue(args, '--work-item'),
    area: getFlagValue(args, '--area'),
    initiative: getFlagValue(args, '--initiative'),
    write_scope: parseCsv(getFlagValue(args, '--write-scope')),
    read_first: parseCsv(getFlagValue(args, '--read-first')),
    objective: getFlagValue(args, '--objective'),
    constraints: parseCsv(getFlagValue(args, '--constraints')),
    expected_output: getFlagValue(args, '--expected-output'),
    context: getFlagValue(args, '--context'),
  });

  if (!result.ok) {
    console.error(`Create handoff failed: [${result.error}] ${result.message}`);
    return 1;
  }

  const data: CreateHandoffResult = result.data;
  console.log(`Created ${data.handoffId}`);
  console.log(`  Path: ${data.handoffRelativePath}`);
  return 0;
}

async function cmdReview(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const handoff = getFlagValue(args, '--handoff');
  const agent = getFlagValue(args, '--agent');
  const accepted = getFlag(args, '--reviewed-and-accept-risks');
  const verbose = getFlag(args, '--verbose');

  if (!dir || !handoff || !agent || !accepted) {
    console.error('Error: --dir, --handoff, --agent, and --reviewed-and-accept-risks are required');
    return 1;
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

async function cmdLaunch(args: string[]): Promise<number> {
  const reviewId = getFlagValue(args, '--review-id');
  const dir = getFlagValue(args, '--dir');
  const json = getFlag(args, '--json');
  const verbose = getFlag(args, '--verbose');

  if (!reviewId || !dir) {
    console.error('Error: --review-id and --dir are required');
    return 1;
  }

  const result = await launch({ reviewId, dir, verbose });
  if (!result.ok) {
    if (json && isLaunchFailureDetail(result.detail)) {
      console.log(JSON.stringify({
        runId: result.detail.runId,
        status: result.detail.status ?? 'failed',
        runDir: result.detail.runDir,
        responsePath: result.detail.responsePath,
        metaPath: result.detail.metaPath,
        error: result.error,
        message: result.message,
      }, null, 2));
      return 1;
    }
    console.error(`Launch failed: [${result.error}] ${result.message}`);
    if (isLaunchFailureDetail(result.detail)) {
      if (result.detail.runDir) console.error(`  Run dir:   ${result.detail.runDir}`);
      if (result.detail.responsePath) console.error(`  Response:  ${result.detail.responsePath}`);
      if (result.detail.metaPath) console.error(`  Meta:      ${result.detail.metaPath}`);
    }
    return 1;
  }

  const data: RunResult = result.data;
  if (json) {
    console.log(JSON.stringify({
      runId: data.runId,
      status: 'completed',
      runDir: data.runDir,
      responsePath: join(data.runDir, 'response.md'),
      metaPath: join(data.runDir, 'metadata', 'meta.json'),
    }, null, 2));
    return 0;
  }

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
  return 0;
}

async function cmdReviewAndLaunch(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const handoff = getFlagValue(args, '--handoff');
  const agent = getFlagValue(args, '--agent');
  const accepted = getFlag(args, '--reviewed-and-accept-risks');
  const verbose = getFlag(args, '--verbose');

  if (!dir || !handoff || !agent || !accepted) {
    console.error('Error: --dir, --handoff, --agent, and --reviewed-and-accept-risks are required');
    return 1;
  }

  const result = await reviewAndLaunch({
    dir,
    handoff,
    agent,
    reviewedAndAcceptRisks: true,
    verbose,
  });

  if (!result.ok) {
    console.error(`Review-and-launch failed: [${result.error}] ${result.message}`);
    return 1;
  }

  const data: RunResult = result.data;
  console.log('Review and launch succeeded.');
  console.log(`  Run ID:    ${data.runId}`);
  console.log(`  Review ID: ${data.reviewId}`);
  console.log(`  Handoff:   ${data.handoffId}`);
  console.log(`  Agent:     ${data.agent}`);
  console.log(`  Mode:      ${data.mode}`);
  console.log(`  Run dir:   ${data.runDir}`);
  return 0;
}

async function cmdCleanup(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir') ?? process.cwd();
  const verbose = getFlag(args, '--verbose');

  const result = await cleanup({ dir, verbose });
  if (!result.ok) {
    console.error(`Cleanup failed: [${result.error}] ${result.message}`);
    return 1;
  }

  const report: CleanupReport = result.data;
  console.log('Cleanup complete.');
  console.log(`  Orphan reviews removed:   ${report.orphanReviews.length}`);
  console.log(`  Orphan runs removed:      ${report.orphanRuns.length}`);
  console.log(`  Stale tokens recovered:   ${report.staleTokens.length}`);
  console.log(`  Expired tokens removed:   ${report.expiredTokens.length}`);
  console.log(`  Total removed:            ${report.totalRemoved}`);
  return 0;
}

async function cmdStatus(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir') ?? process.cwd();
  const result = await status(dir);
  if (!result.ok) {
    console.error(`Status failed: [${result.error}] ${result.message}`);
    return 1;
  }

  const data: StatusResult = result.data;
  console.log(`Dispatch status for: ${resolve(data.repoRoot)}\n`);
  console.log(`Pending reviews: ${data.pending.length}`);
  console.log(`Active launches: ${data.launching.length}`);
  console.log(`Stale launching tokens: ${data.staleLaunching.length}`);
  console.log(`Consumed tokens: ${data.consumed.length}`);
  console.log(`Rejected tokens: ${data.rejected.length}`);
  console.log(`Runs in repo: ${data.runCount}`);
  console.log(`Review bundles in repo: ${data.reviewCount}`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const showHelp = getFlag(args, '--help') || getFlag(args, '-h');
  const showVersion = getFlag(args, '--version') || getFlag(args, '-v');

  if (showVersion) {
    console.log(`kb dispatch v${VERSION}`);
    return 0;
  }

  const command = args.find((arg) => !arg.startsWith('-'));
  if (showHelp || !command) {
    console.log(HELP_TEXT);
    return 0;
  }

  switch (command) {
    case 'init-config':
      return cmdInitConfig(args);
    case 'create-handoff':
      return cmdCreateHandoff(args);
    case 'review':
      return cmdReview(args);
    case 'launch':
      return cmdLaunch(args);
    case 'review-and-launch':
      return cmdReviewAndLaunch(args);
    case 'cleanup':
      return cmdCleanup(args);
    case 'status':
      return cmdStatus(args);
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help to see available commands.');
      return 1;
  }
}
