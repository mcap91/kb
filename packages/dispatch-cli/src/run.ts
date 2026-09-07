import { join, resolve } from 'node:path';

import {
  VERSION,
  checkEnvironment,
  cleanup,
  createHandoff,
  initConfig,
  launch,
  launchDispatchBackground,
  review,
  reviewAndLaunch,
  status,
  waitForRun,
} from '@kb/dispatch-core';

import type {
  CheckEnvironmentResult,
  CleanupReport,
  CreateHandoffResult,
  LaunchEvent,
  ReviewResult,
  RunResult,
  StatusResult,
  WaitForRunResult,
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

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'n/a';
  return `${bytes}B`;
}

function createLaunchProgressReporter(): (event: LaunchEvent) => void {
  let lastHeartbeatPrint = Date.now();
  return (event: LaunchEvent): void => {
    switch (event.type) {
      case 'run_created':
        process.stderr.write(`[dispatch] run created ${event.runId}\n`);
        process.stderr.write(`[dispatch] run dir: ${event.runDir}\n`);
        process.stderr.write(`[dispatch] response: ${event.responsePath}\n`);
        process.stderr.write(`[dispatch] stderr: ${event.stderrPath}\n`);
        break;
      case 'spawned':
        process.stderr.write(`[dispatch] spawned pid=${event.pid} cwd=${event.cwd}\n`);
        break;
      case 'token_consumed':
        process.stderr.write(`[dispatch] token consumed; streaming output to response.md\n`);
        break;
      case 'heartbeat': {
        const now = Date.now();
        if (now - lastHeartbeatPrint < 30_000) {
          break;
        }
        lastHeartbeatPrint = now;
        const heartbeatMs = Date.parse(event.heartbeatAt);
        const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, now - heartbeatMs) : -1;
        process.stderr.write(
          `[dispatch] heartbeat age=${heartbeatAgeMs}ms response=${formatBytes(event.responseBytes)} stderr=${formatBytes(event.stderrBytes)} stdout=${formatBytes(event.stdoutBytes)}\n`,
        );
        break;
      }
      case 'finalized':
        process.stderr.write(`[dispatch] finalized status=${event.status} exit=${event.exitCode}\n`);
        process.stderr.write(`[dispatch] response: ${event.responsePath}\n`);
        process.stderr.write(`[dispatch] meta: ${event.metaPath}\n`);
        break;
    }
  };
}

const HELP_TEXT = `
kb dispatch — reviewed multi-agent dispatch protocol

Usage:
  npm run dispatch -- <command> [options]

Commands:
  init-config                Initialize operator dispatch configuration
  check-environment          Probe and record host sandbox capabilities
  create-handoff             Create a repo-local HO handoff
  review                     Review a handoff document
  launch                     Launch a reviewed handoff
  review-and-launch          Review and immediately launch a handoff
  cleanup                    Clean up stale dispatch state
  status                     Show current dispatch state
  dispatch                   Run the v2 dispatch pipeline
  wait-for-run               Wait for a run to reach terminal status

Global Options:
  --help                     Show this help text
  --version                  Show version
  --verbose                  Enable verbose output

Command Options:
  init-config
    --force                  Overwrite the existing launcher registry

  check-environment
    (no required flags)

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
    --model <model>          Override model for this run
    --effort <level>         Override effort/reasoning level for this run

  review-and-launch
    --dir <path>             Repository root directory (required)
    --handoff <rel-path>     Relative path to handoff file (required)
    --agent <name>           Agent name from registry (required)
    --reviewed-and-accept-risks  Explicit operator acknowledgment (required)
    --model <model>          Override model for this run
    --effort <level>         Override effort/reasoning level for this run

  cleanup
    --dir <path>             Repository root directory (defaults to cwd)

  status
    --dir <path>             Repository root directory (defaults to cwd)

  dispatch                   Run the v2 dispatch pipeline (always backgrounds)
    --dir <path>             Repository root directory (required)
    --handoff <rel-path>     Relative path to handoff file (required)
    --model <alias>          Model alias from registry (required)
    --effort <level>         Effort/reasoning level (refused if unsupported)
    --no-preflight           Skip bwrap preflight check
    --wait                   Block until the run reaches terminal status
    --json                   Print machine-readable output
    --verbose                Verbose stderr progress

  wait-for-run
    --dir <path>             Repository root directory (required)
    --run-id <id>            Run ID (required for v2 runs)
    --review-id <id>         Review ID (alternative, v1 runs)
    --timeout-seconds <n>    Timeout in seconds (default: 1800, no cap)
    --poll-interval-ms <n>   Poll interval in ms (default: 1000)
    --json                   Print machine-readable output
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

async function cmdCheckEnvironment(): Promise<number> {
  const result = await checkEnvironment();
  if (!result.ok) {
    console.error(`Environment check failed: [${result.error}] ${result.message}`);
    return 1;
  }

  const data: CheckEnvironmentResult = result.data;
  const rec = data.record;
  console.log(`Config directory: ${data.configDir}`);
  console.log(`Record: ${data.recordPath}`);
  console.log(`Checked: ${rec.checked_at}`);
  console.log(`Platform: ${rec.platform}/${rec.arch}`);
  console.log(`Claude Linux sandbox: ${rec.capabilities.claude_linux_sandbox.status}`);
  console.log(`Claude Linux add-dir: ${rec.capabilities.claude_linux_add_dir.status}`);
  console.log(`Codex Linux sandbox: ${rec.capabilities.codex_linux_sandbox.status}`);

  if (rec.container) {
    const c = rec.container;
    const cgroup = c.cgroup_hint ? `, cgroup=${c.cgroup_hint}` : '';
    console.log(`Container detected: ${c.detected} (k8s=${c.kubernetes_service_host}, dockerenv=${c.dockerenv}${cgroup})`);
  }
  if (rec.writability) {
    console.log(`HOME writable: ${rec.writability.home.writable} (${rec.writability.home.path ?? 'unset'})`);
    console.log(`Config dir writable: ${rec.writability.config_dir.writable} (${rec.writability.config_dir.path ?? 'unresolved'})`);
  }

  console.log('');
  console.log('Route viability (what dispatch can do on this host):');
  for (const verdict of data.verdicts) {
    console.log(`  ${verdict.route}: ${verdict.viability}`);
    console.log(`    ${verdict.detail}`);
  }
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
  const model = getFlagValue(args, '--model');
  const effort = getFlagValue(args, '--effort');

  if (!reviewId || !dir) {
    console.error('Error: --review-id and --dir are required');
    return 1;
  }

  const result = await launch({
    reviewId,
    dir,
    verbose,
    onEvent: json ? undefined : createLaunchProgressReporter(),
    model,
    effort,
  });
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
  const model = getFlagValue(args, '--model');
  const effort = getFlagValue(args, '--effort');

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
    model,
    effort,
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

async function cmdDispatch(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const handoff = getFlagValue(args, '--handoff');
  const model = getFlagValue(args, '--model');
  const effort = getFlagValue(args, '--effort');
  const noPreflight = getFlag(args, '--no-preflight');
  const verbose = getFlag(args, '--verbose');
  const json = getFlag(args, '--json');
  const wait = getFlag(args, '--wait');

  if (!dir || !handoff || !model) {
    console.error('Error: --dir, --handoff, and --model are required');
    return 1;
  }

  const result = await launchDispatchBackground({
    dir, handoff, model, effort,
    preflight: !noPreflight, verbose,
  });

  if (!result.ok) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: result.error, message: result.message }, null, 2));
    } else {
      console.error(`Dispatch failed: [${result.error}] ${result.message}`);
    }
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.log(`Dispatch started.`);
    console.log(`  Run ID:    ${result.data.runId}`);
    console.log(`  Handoff:   ${result.data.handoffId}`);
    console.log(`  Model:     ${result.data.model}`);
    console.log(`  State:     ${result.data.statePath}`);
    console.log(`  Log:       ${result.data.logPath}`);
    console.log(`  Response:  ${result.data.responsePath}`);
  }

  if (wait) {
    // --wait chains wait-for-run with a long timeout (a blocking primitive for
    // live-gate/debug use — S1's ruling 1 keeps `dispatch` itself always-background).
    const waitResult = await waitForRun({
      dir, runId: result.data.runId,
      timeoutSeconds: 1800,
    });
    if (!waitResult.ok) {
      console.error(`Wait failed: [${waitResult.error}] ${waitResult.message}`);
      return 1;
    }
    if (json) {
      console.log(JSON.stringify(waitResult.data, null, 2));
    } else {
      // s1-rulings ruling 10: a delivery refusal is DATA, not a launch failure —
      // print the outcome and keep exit 0; the response doc's `outcome` field
      // (and --json's full envelope) carry the orchestration signal.
      console.log(`Dispatch completed. Delivery: ${(waitResult.data as any).status ?? 'unknown'}`);
    }
  }

  return 0;
}

async function cmdWaitForRun(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const runId = getFlagValue(args, '--run-id');
  const reviewId = getFlagValue(args, '--review-id');
  const timeoutSecondsRaw = getFlagValue(args, '--timeout-seconds');
  const pollIntervalMsRaw = getFlagValue(args, '--poll-interval-ms');
  const json = getFlag(args, '--json');

  if (!dir || (!runId && !reviewId)) {
    console.error('Error: --dir and one of --run-id or --review-id are required');
    return 1;
  }

  const result = await waitForRun({
    dir,
    runId,
    reviewId,
    timeoutSeconds: timeoutSecondsRaw !== undefined ? Number(timeoutSecondsRaw) : undefined,
    pollIntervalMs: pollIntervalMsRaw !== undefined ? Number(pollIntervalMsRaw) : undefined,
  });

  if (!result.ok) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: result.error, message: result.message }, null, 2));
    } else {
      console.error(`Wait failed: [${result.error}] ${result.message}`);
    }
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  }

  const data: WaitForRunResult = result.data;
  console.log(`Run ${data.runId} status: ${data.status}`);
  console.log(`  Handoff:   ${data.handoffId}`);
  console.log(`  Run dir:   ${data.runDir}`);
  console.log(`  Started:   ${data.startedAt ?? 'n/a'}`);
  console.log(`  Heartbeat: ${data.heartbeatAt ?? 'n/a'}`);
  console.log(`  Completed: ${data.completedAt ?? 'n/a'}`);
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
    case 'check-environment':
      return cmdCheckEnvironment();
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
    case 'dispatch':
      return cmdDispatch(args);
    case 'wait-for-run':
      return cmdWaitForRun(args);
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help to see available commands.');
      return 1;
  }
}
