/**
 * `npm run eval -- <flags>` entry point (WK-0237 slice A). Two subcommands
 * today: `--jail-smoke` (no model call; proves effective jail access) and
 * `--capture <name> ...` (one real `claude -p` run, raw logs only). Room is
 * left for slice B's `--suite <name>` flag alongside these.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { SYSTEM_ROOTS } from '@kb/dispatch-core';

import { buildClaudeArgv } from './claude-argv.js';
import { checkInstalledExactly, installCommand, installSkill, resetTestKb } from './install.js';
import { buildJailSmokeChecks, buildJailSmokeScript, checkJailSmokeComplete, parseJailSmokeOutput } from './jail-smoke.js';
import { buildEvalJailArgs, EVAL_CLI_PACKAGE_DIR, EVAL_HOME } from './jail.js';
import { launch } from './launch.js';
import type { McpKind } from './mcp-config.js';
import { writeMcpConfig } from './mcp-config.js';
import { discoverHostPaths } from './paths.js';

function getFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

/** Splits a `<src>:<name>` spec on its LAST colon (a host path may itself contain colons; the install name never does). */
function splitSrcName(spec: string): { src: string; name: string } | null {
  const idx = spec.lastIndexOf(':');
  if (idx <= 0 || idx === spec.length - 1) return null;
  return { src: spec.slice(0, idx), name: spec.slice(idx + 1) };
}

async function runJailSmoke(): Promise<number> {
  const hostPaths = discoverHostPaths();
  if (!hostPaths.ok) {
    console.error(`jail-smoke: ${hostPaths.message}`);
    return 1;
  }

  const runDir = mkdtempSync(join(tmpdir(), 'kb-eval-jail-smoke-'));
  const runHome = join(runDir, 'home');
  mkdirSync(runHome, { recursive: true });

  try {
    const jailArgs = buildEvalJailArgs({
      systemRoots: SYSTEM_ROOTS,
      runHome,
      credentialsFile: hostPaths.data.credentialsFile,
      testKb: hostPaths.data.testKb,
      kbRoot: hostPaths.data.kbRoot,
      cliPackageDir: hostPaths.data.cliPackageDir,
      resolvConfRealpath: hostPaths.data.resolvConfRealpath,
    });

    const checks = buildJailSmokeChecks({ operatorHome: homedir() });
    const script = buildJailSmokeScript(checks);

    const result = spawnSync('bwrap', [...jailArgs, '/bin/sh', '-c', script], { encoding: 'utf8' });
    if (result.error) {
      console.error(`jail-smoke: failed to run bwrap: ${result.error.message}`);
      return 1;
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    const outcomes = parseJailSmokeOutput(result.stdout ?? '');
    for (const outcome of outcomes) {
      console.log(`${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.name}`);
    }

    const complete = checkJailSmokeComplete(outcomes);
    if (!complete.ok) {
      console.error(`jail-smoke: ${complete.message}`);
      return 1;
    }
    return 0;
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
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

export async function run(args: string[]): Promise<number> {
  if (getFlag(args, '--jail-smoke')) {
    return runJailSmoke();
  }
  if (getFlag(args, '--capture')) {
    return runCapture(args);
  }
  console.error('Usage: npm run eval -- --jail-smoke | --capture <name> --baseline <sha> --prompt <text> [...]');
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
