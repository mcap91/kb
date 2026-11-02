/**
 * `npm run eval -- <flags>` entry point. Three subcommands: `--jail-smoke`
 * (no model call; proves effective jail access), `--capture <name> ...`
 * (one real `claude -p` run, raw logs only), and `--suite <name> [--scenario
 * <id>]... [--resume]` (WK-0237 slice B1d: every scenario of one suite, all
 * repeats and conditions, via `suite.ts`'s `runSuite`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYSTEM_ROOTS } from '@kb/dispatch-core';

import { buildClaudeArgv } from './claude-argv.js';
import { checkInstalledExactly, installCommand, installSkill, resetTestKb } from './install.js';
import { performJailSmoke, runJailSmokeForPreflight } from './jail-smoke-runner.js';
import { buildEvalJailArgs, EVAL_CLI_PACKAGE_DIR, EVAL_HOME } from './jail.js';
import { launch } from './launch.js';
import type { McpKind } from './mcp-config.js';
import { writeMcpConfig } from './mcp-config.js';
import { discoverHostPaths } from './paths.js';
import { runSuite } from './suite.js';

function getFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

/** Every value following a repeatable flag (e.g. `--scenario a --scenario b` -> `['a', 'b']`). */
function getFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

/** Splits a `<src>:<name>` spec on its LAST colon (a host path may itself contain colons; the install name never does). */
function splitSrcName(spec: string): { src: string; name: string } | null {
  const idx = spec.lastIndexOf(':');
  if (idx <= 0 || idx === spec.length - 1) return null;
  return { src: spec.slice(0, idx), name: spec.slice(idx + 1) };
}

async function runJailSmoke(): Promise<number> {
  const result = await performJailSmoke();
  if (!result.ok) {
    console.error(`jail-smoke: ${result.message}`);
    return 1;
  }

  for (const outcome of result.data.outcomes) {
    console.log(`${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.name}`);
  }

  if (!result.data.complete.ok) {
    console.error(`jail-smoke: ${result.data.complete.message}`);
    return 1;
  }
  return 0;
}

async function runCapture(args: string[]): Promise<number> {
  const name = getFlagValue(args, '--capture');
  const baseline = getFlagValue(args, '--baseline');
  const prompt = getFlagValue(args, '--prompt');
  const model = getFlagValue(args, '--model');
  const budgetUsdStr = getFlagValue(args, '--budget-usd');
  const timeoutSecStr = getFlagValue(args, '--timeout-sec');
  const mcpStr = getFlagValue(args, '--mcp') ?? 'none';
  const installCommandSpec = getFlagValue(args, '--install-command');
  const installSkillSpec = getFlagValue(args, '--install-skill');

  if (name === undefined || baseline === undefined || prompt === undefined) {
    console.error('capture: --capture <name>, --baseline <sha>, and --prompt <text> are all required.');
    return 1;
  }
  if (mcpStr !== 'kb-wiki' && mcpStr !== 'none') {
    console.error(`capture: --mcp must be 'kb-wiki' or 'none', got '${mcpStr}'.`);
    return 1;
  }
  const mcpKind: McpKind = mcpStr;

  const hostPaths = discoverHostPaths();
  if (!hostPaths.ok) {
    console.error(`capture: ${hostPaths.message}`);
    return 1;
  }
  const { testKb, kbRoot, cliPackageDir, cliBinaryRelPath, credentialsFile, testKbData, claudeRealpath, resolvConfRealpath } =
    hostPaths.data;

  const captureDir = join(testKbData, 'evals', 'captures', name);
  if (existsSync(captureDir)) {
    console.error(`capture: ${captureDir} already exists; refusing to overwrite a previous capture.`);
    return 1;
  }

  const runHome = join(captureDir, 'home');
  mkdirSync(runHome, { recursive: true });

  const reset = resetTestKb(testKb, baseline);
  if (!reset.ok) {
    console.error(`capture: ${reset.message}`);
    return 1;
  }

  let expectedHomeCommands: string[] = [];
  let expectedTestKbSkills: string[] = [];

  if (installCommandSpec !== undefined) {
    const parsed = splitSrcName(installCommandSpec);
    if (parsed === null) {
      console.error(`capture: --install-command must be '<src>:<name>', got '${installCommandSpec}'.`);
      return 1;
    }
    const installed = installCommand({
      srcFile: parsed.src,
      destDir: join(runHome, '.claude', 'commands'),
      name: parsed.name,
    });
    if (!installed.ok) {
      console.error(`capture: ${installed.message}`);
      return 1;
    }
    expectedHomeCommands = [`${parsed.name}.md`];
  }

  if (installSkillSpec !== undefined) {
    const parsed = splitSrcName(installSkillSpec);
    if (parsed === null) {
      console.error(`capture: --install-skill must be '<srcdir>:<name>', got '${installSkillSpec}'.`);
      return 1;
    }
    const installed = installSkill({
      srcDir: parsed.src,
      destParentDir: join(testKb, '.claude', 'skills'),
      name: parsed.name,
    });
    if (!installed.ok) {
      console.error(`capture: ${installed.message}`);
      return 1;
    }
    expectedTestKbSkills = [parsed.name];
  }

  const exactFiles = checkInstalledExactly([
    { dir: join(runHome, '.claude', 'commands'), expectedNames: expectedHomeCommands },
    { dir: join(runHome, '.claude', 'skills'), expectedNames: [] },
    { dir: join(testKb, '.claude', 'commands'), expectedNames: [] },
    { dir: join(testKb, '.claude', 'skills'), expectedNames: expectedTestKbSkills },
  ]);
  if (!exactFiles.ok) {
    console.error(`capture: ${exactFiles.message}`);
    return 1;
  }

  const mcpConfigHostPath = join(runHome, 'mcp-config.json');
  const mcpConfigWrite = writeMcpConfig(mcpConfigHostPath, mcpKind);
  if (!mcpConfigWrite.ok) {
    console.error(`capture: ${mcpConfigWrite.message}`);
    return 1;
  }
  const mcpConfigJailPath = `${EVAL_HOME}/mcp-config.json`;

  const jailArgs = buildEvalJailArgs({
    systemRoots: SYSTEM_ROOTS,
    runHome,
    credentialsFile,
    testKb,
    kbRoot,
    cliPackageDir,
    resolvConfRealpath,
  });

  const claudeArgv = buildClaudeArgv({
    prompt,
    model,
    budgetUsd: budgetUsdStr !== undefined ? Number(budgetUsdStr) : undefined,
    mcpConfigPath: mcpConfigJailPath,
  });

  const cliBinaryJailPath = `${EVAL_CLI_PACKAGE_DIR}/${cliBinaryRelPath}`;
  const command = ['bwrap', ...jailArgs, cliBinaryJailPath, ...claudeArgv];

  let cliVersion = 'unknown';
  try {
    cliVersion = execFileSync(claudeRealpath, ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`capture: warning: failed to probe claude --version: ${err instanceof Error ? err.message : String(err)}`);
  }

  const timeoutMs = timeoutSecStr !== undefined ? Number(timeoutSecStr) * 1000 : undefined;

  const launched = await launch({
    command,
    captureDir,
    timeoutMs,
    metadata: { baselineSha: baseline, cliVersion },
  });
  if (!launched.ok) {
    console.error(`capture: ${launched.message}`);
    return 1;
  }

  console.log(`capture: wrote ${captureDir} (exit ${String(launched.data.exitCode)}, timedOut=${String(launched.data.timedOut)})`);
  return launched.data.exitCode === 0 && !launched.data.timedOut ? 0 : 1;
}

const JUDGE_PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'judge-prompt.md');

async function runSuiteCommand(args: string[]): Promise<number> {
  const name = getFlagValue(args, '--suite');
  if (name === undefined) {
    console.error('suite: --suite <name> is required.');
    return 1;
  }
  const scenarioIds = getFlagValues(args, '--scenario');
  const resume = getFlag(args, '--resume');

  const hostPaths = discoverHostPaths();
  if (!hostPaths.ok) {
    console.error(`suite: ${hostPaths.message}`);
    return 1;
  }
  const { testKb, kbRoot, cliPackageDir, cliBinaryRelPath, credentialsFile, testKbData, claudeRealpath, resolvConfRealpath } =
    hostPaths.data;

  let cliVersion = 'unknown';
  try {
    cliVersion = execFileSync(claudeRealpath, ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`suite: warning: failed to probe claude --version: ${err instanceof Error ? err.message : String(err)}`);
  }

  let judgePromptTemplate: string;
  try {
    judgePromptTemplate = readFileSync(JUDGE_PROMPT_PATH, 'utf8');
  } catch (err) {
    console.error(`suite: failed to read ${JUDGE_PROMPT_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const result = await runSuite({
    suiteDir: join(kbRoot, 'evals', 'scenarios', name),
    resultsRoot: join(testKbData, 'evals', 'results'),
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : undefined,
    resume,
    testKb,
    kbRoot,
    credentialsFile,
    cliPackageDir,
    cliBinaryRelPath,
    resolvConfRealpath,
    systemRoots: SYSTEM_ROOTS,
    cliVersion,
    judgePromptTemplate,
    launch,
    runJailSmoke: runJailSmokeForPreflight,
  });

  if (!result.ok) {
    console.error(`suite: ${result.message}`);
    return 1;
  }
  console.log(`suite: wrote ${result.data.resultSetDir} (gate: ${result.data.summary.gateVerdict})`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  if (getFlag(args, '--jail-smoke')) {
    return runJailSmoke();
  }
  if (getFlag(args, '--capture')) {
    return runCapture(args);
  }
  if (getFlag(args, '--suite')) {
    return runSuiteCommand(args);
  }
  console.error(
    'Usage: npm run eval -- --jail-smoke | --capture <name> --baseline <sha> --prompt <text> [...] | --suite <name> [--scenario <id>]... [--resume]',
  );
  return 1;
}

const args = process.argv.slice(2);
run(args)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exitCode = 1;
  });
