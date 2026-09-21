import { resolve } from 'node:path';

import {
  VERSION,
  checkEnvironment,
  cleanup,
  createHandoff,
  initConfig,
  launchDispatchBackground,
  status,
  waitForRun,
} from '@kb/dispatch-core';

import type {
  CheckEnvironmentResult,
  CleanupReport,
  CreateHandoffResult,
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

const HELP_TEXT = `
kb dispatch — reviewed multi-agent dispatch protocol

Usage:
  npm run dispatch -- <command> [options]

Commands:
  init-config                Initialize operator dispatch configuration
  check-environment          Probe and record host sandbox capabilities
  create-handoff             Create a repo-local HO handoff
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
    --acceptance <csv>       Acceptance criteria, comma-separated (required)
    --validation <csv>       Validation commands, comma-separated (required)
    --work-item <WK-id>      Optional linked work item
    --write-scope <csv>      Optional write scope paths
    --read-first <csv>       Optional Read First paths
    --objective <text>       Optional objective section
    --constraints <csv>      Optional constraint bullets
    --expected-output <text> Optional expected output section
    --context <text>         Optional context section
    --web                    Optional flag: worker needs web access
    --credentials <csv>      Optional credential names, comma-separated
    --data-mounts <csv>      Optional data mount paths, comma-separated
    --export-mounts <csv>    Optional export mount paths, comma-separated
    --base-ref <ref>         Optional base ref (branch/commit) for the worker
    --vars <csv>             Optional KEY=value vars, comma-separated

  cleanup
    --dir <path>             Repository root directory (defaults to cwd)

  status
    --dir <path>             Repository root directory (defaults to cwd)

  dispatch                   Run the v2 dispatch pipeline (always backgrounds)
    --dir <path>             Repository root directory (required)
    --handoff <rel-path>     Relative path to handoff file (required)
    --model <alias>          Model alias from registry (required)
    --backend <name>         Backend name from registry, e.g. openrouter, ollama (required)
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
  const acceptance = parseCsv(getFlagValue(args, '--acceptance'));
  const validation = parseCsv(getFlagValue(args, '--validation'));

  if (!dir || !title || !subject || !mode || allowedAgents.length === 0 || acceptance.length === 0 || validation.length === 0) {
    console.error('Error: --dir, --title, --subject, --allowed-agents, --mode, --acceptance, and --validation are required');
    return 1;
  }

  if (mode === 'implement' && !getFlagValue(args, '--work-item')) {
    console.error('Error: --work-item is required when --mode is implement (WORK_ITEM_NOT_FOUND gate)');
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
    acceptance,
    validation,
    web: getFlag(args, '--web'),
    credentials: parseCsv(getFlagValue(args, '--credentials')),
    data_mounts: parseCsv(getFlagValue(args, '--data-mounts')),
    export_mounts: parseCsv(getFlagValue(args, '--export-mounts')),
    base_ref: getFlagValue(args, '--base-ref'),
    vars: parseCsv(getFlagValue(args, '--vars')),
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

  if (data.runs && data.runs.length > 0) {
    console.log(`\nRuns (${data.runs.length}):`);
    for (const run of data.runs) {
      const runtime = run.runtimeSecs !== null ? `${Math.round(run.runtimeSecs)}s` : '-';
      const hbAge = run.heartbeatAgeSecs !== null ? `${Math.round(run.heartbeatAgeSecs)}s` : '-';
      const stale = run.stale ? ' STALE' : '';
      const delivery = run.deliveryStatus ? ` delivery=${run.deliveryStatus}` : '';
      const branch = run.branch ? ` branch=${run.branch}` : '';
      console.log(`  ${run.runId} [${run.status}] ${run.handoffId} model=${run.model ?? '-'} runtime=${runtime} hb_age=${hbAge}${stale}${delivery}${branch}`);
      if (run.logTail && run.logTail.length > 0) {
        for (const line of run.logTail) {
          console.log(`    | ${line}`);
        }
      }
    }
  }

  return 0;
}

async function cmdDispatch(args: string[]): Promise<number> {
  const dir = getFlagValue(args, '--dir');
  const handoff = getFlagValue(args, '--handoff');
  const model = getFlagValue(args, '--model');
  const backend = getFlagValue(args, '--backend');
  const effort = getFlagValue(args, '--effort');
  const noPreflight = getFlag(args, '--no-preflight');
  const verbose = getFlag(args, '--verbose');
  const json = getFlag(args, '--json');
  const wait = getFlag(args, '--wait');

  if (!dir || !handoff || !model || !backend) {
    console.error('Error: --dir, --handoff, --model, and --backend are required');
    return 1;
  }

  const result = await launchDispatchBackground({
    dir, handoff, model, backend, effort,
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

/** Terminal statuses that count as a successful run for wait-for-run's exit code. */
const SUCCESS_RUN_STATUSES = new Set(['delivered', 'completed']);

/**
 * wait-for-run's exit code reflects the run's terminal status, not merely
 * whether the wait itself completed without error: `delivered`/`completed`
 * exit 0; `failed`/`refused`/`timed_out`/`cancelled` (or any other
 * non-success status) exit 1 — so a caller chaining on `$?` sees the run's
 * outcome, not just "the wait didn't error."
 */
function exitCodeForRunStatus(status: string): number {
  return SUCCESS_RUN_STATUSES.has(status) ? 0 : 1;
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

  const data: WaitForRunResult = result.data;
  const exitCode = exitCodeForRunStatus(data.status);

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return exitCode;
  }

  console.log(`Run ${data.runId} status: ${data.status}`);
  console.log(`  Handoff:   ${data.handoffId}`);
  console.log(`  Run dir:   ${data.runDir}`);
  console.log(`  Started:   ${data.startedAt ?? 'n/a'}`);
  console.log(`  Heartbeat: ${data.heartbeatAt ?? 'n/a'}`);
  console.log(`  Completed: ${data.completedAt ?? 'n/a'}`);
  return exitCode;
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
