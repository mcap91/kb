/**
 * One scored run of one scenario, under one condition and repeat (WK-0237
 * slice B1c; scope 13, 15.2, 15.5, 17, Resolutions 1, 4, 12, 13; the
 * 2026-11-01 overseer rider on index rebuild). `runScenarioOnce` is the unit
 * the B1d `--suite` runner calls once per (scenario, condition, repeat).
 *
 * Reuses slice A (jail, install, launch, MCP config, claude argv, host
 * paths) and B1a/B1b (validity, stream log, checks, diff, outcome,
 * citations, judge, metrics) — nothing here reimplements them. The launcher
 * is injected (`opts.launch`, same shape as `launch.ts`'s `launch`), so tests
 * run with no real `claude` or `bwrap` call.
 *
 * Run dir layout written under `opts.runDir`:
 *   stream.jsonl, stderr.log, run.json   — written by the main launch call
 *   diff.txt                             — `git diff <seeded-sha>`
 *   status.txt                           — `git status --porcelain`
 *   wk-before.md, wk-after.md            — the target WK's full body text
 *   metrics.json                         — this run's `RunMetrics` record
 *   home/                                — the main run's jail-bound home
 *   judge-<n>/                           — one per judged added row (max 3):
 *     prompt.txt, stream.jsonl, stderr.log, run.json, home/
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSearchIndex, lint, loadManifest, readResolutions, type ResolutionRow } from '@kb/wiki-core';

import { runCheck, type CheckContext } from './checks.js';
import { buildClaudeArgv } from './claude-argv.js';
import { type CitedFile, buildJudgePrompt, type JudgeVerdict, judgePromptSha256, parseJudgeVerdict } from './judge.js';
import { checkRowProse, parseCitations, resolveCitations } from './citations.js';
import { isUnderWiki, parseGitDiff } from './diff.js';
import { checkInstalledExactly, installSkill } from './install.js';
import { buildEvalJailArgs, EVAL_CLI_PACKAGE_DIR, EVAL_HOME } from './jail.js';
import type { LaunchOpts, LaunchResult } from './launch.js';
import { writeMcpConfig, type McpKind } from './mcp-config.js';
import { CHECK_LIST_VERSION, buildRunMetrics, type CheckKindOutcome, type RunMetrics, type RunMetricsPins } from './metrics.js';
import { evaluateOutcome } from './outcome.js';
import { fail, ok, type EvalResult } from './result.js';
import { hashScenarioDir } from './scenario-hash.js';
import type { Scenario, Suite } from './scenario-schema.js';
import { parseStreamLog } from './stream-log.js';
import { checkRunValidity, type ValidityOutcome } from './validity.js';

/** Same call shape as `launch.ts`'s `launch` — injected so tests never spawn a real `claude`/`bwrap` process. */
export type LaunchFn = (opts: LaunchOpts) => Promise<EvalResult<LaunchResult>>;

export type SuiteCondition = Suite['conditions'][number];

export interface RunScenarioOnceOpts {
  suite: Suite;
  scenario: Scenario;
  /** The scenario's own directory (holding `scenario.json` and `records/`) — used to seed test_kb and to pin `scenario_dir_sha256`. */
  scenarioDir: string;
  condition: SuiteCondition;
  repeat: number;
  /** Host dir to write this run's artifacts into (must already exist or be creatable). */
  runDir: string;
  testKb: string;
  kbRoot: string;
  credentialsFile: string;
  cliPackageDir: string;
  cliBinaryRelPath: string;
  resolvConfRealpath: string | null;
  systemRoots: readonly string[];
  /** `claude --version` output, pinned into every metrics file this run writes. */
  cliVersion: string;
  /** `judge-prompt.md`'s text, passed in by the caller (judge.ts stays a pure string function; this module does not read it from disk). */
  judgePromptTemplate: string;
  /** `suite.ts`'s `hashHarnessTree(kbRoot)`, computed once by the caller and pinned into this run's metrics -- this module makes no git calls for it. */
  harnessTree: string;
  launch: LaunchFn;
}

const JUDGE_MODEL = 'claude-sonnet-5';
const JUDGE_BUDGET_USD = 2;
const MAX_JUDGED_ROWS = 3;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runGit(args: string[], cwd: string): EvalResult<string> {
  try {
    return ok(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    return fail('GIT_FAILED', `git ${args.join(' ')} in ${cwd} failed: ${describeError(err)}`);
  }
}

function readFileOrFail(path: string, code: string): EvalResult<string> {
  try {
    return ok(readFileSync(path, 'utf8'));
  } catch (err) {
    return fail(code, `failed to read ${path}: ${describeError(err)}`);
  }
}

export interface ResolvedRoleText {
  roleTextBlob: string;
  /** The command body text to install — set only when `condition.install_command` is not null. */
  commandBody: string | null;
}

/**
 * Resolves a condition's role-text blob id (`install_command`: the git blob
 * id of `<git_ref>:<path>`, plus the body text to install; `install_skills`:
 * the comma-joined `git hash-object` ids of each skill's `SKILL.md` in the
 * kb working tree). Shared by `runScenarioOnce` step 6 and the `--suite`
 * runner's preflight/result-set pins (WK-0237 slice B1d) — the same git
 * calls serve as both the "install source missing" check and the blob-id
 * pin, so neither caller reimplements the other's git calls.
 */
export function resolveRoleText(condition: SuiteCondition, kbRoot: string): EvalResult<ResolvedRoleText> {
  if (condition.install_command !== null) {
    const { git_ref, path } = condition.install_command;
    const showResult = runGit(['show', `${git_ref}:${path}`], kbRoot);
    if (!showResult.ok) return showResult;
    const blobResult = runGit(['rev-parse', `${git_ref}:${path}`], kbRoot);
    if (!blobResult.ok) return blobResult;
    return ok({ roleTextBlob: blobResult.data.trim(), commandBody: showResult.data });
  }
  const blobs: string[] = [];
  for (const skill of condition.install_skills) {
    const hashResult = runGit(['hash-object', join(skill.path, 'SKILL.md')], kbRoot);
    if (!hashResult.ok) return hashResult;
    blobs.push(hashResult.data.trim());
  }
  return ok({ roleTextBlob: blobs.join(','), commandBody: null });
}

/**
 * Scans a stream for its `system`/`init` event's `model`, tolerating lines
 * that fail to parse (unlike `parseStreamLog`'s strict, fail-fast parse) —
 * the invalid-run path's streams (budget-stop, timeout, API error) may be
 * partial or malformed. Returns null when no init event with a model is
 * found, e.g. an API error or a timeout with no captured output at all.
 */
function extractInitModelId(streamLines: string[]): string | null {
  for (const raw of streamLines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      return event.model;
    }
  }
  return null;
}

/** The raw last stream line's `total_cost_usd`, defaulting to 0 (a timed-out or malformed run never meters cost). */
function extractTotalCostUsd(streamLines: string[]): number {
  const nonEmpty = streamLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return 0;
  try {
    const last = JSON.parse(nonEmpty[nonEmpty.length - 1]) as Record<string, unknown>;
    return typeof last.total_cost_usd === 'number' ? last.total_cost_usd : 0;
  } catch {
    return 0;
  }
}

/**
 * Performs one scored run of `opts.scenario` under `opts.condition`, repeat
 * `opts.repeat`: steps 1-14 of WK-0237 Constraints, in order. Writes the run
 * dir documented on this module and returns the metrics record it wrote.
 */
export async function runScenarioOnce(opts: RunScenarioOnceOpts): Promise<EvalResult<RunMetrics>> {
  const { suite, scenario, condition, testKb, kbRoot } = opts;

  mkdirSync(opts.runDir, { recursive: true });
  const runHome = join(opts.runDir, 'home');
  mkdirSync(runHome, { recursive: true });

  // 1. Reset test_kb to the suite's pinned baseline.
  const reset = resetTestKbStep(testKb, suite.baseline_sha);
  if (!reset.ok) return reset;

  // 2. Copy the scenario's seeded records into test_kb/wiki/.
  const recordsDir = join(opts.scenarioDir, 'records');
  if (existsSync(recordsDir)) {
    try {
      cpSync(recordsDir, join(testKb, 'wiki'), { recursive: true });
    } catch (err) {
      return fail('RECORDS_COPY_FAILED', `failed to copy ${recordsDir} into ${testKb}/wiki: ${describeError(err)}`);
    }
  }

  // 3. Rebuild the search index on the host.
  const indexResult = await buildSearchIndex({ dir: testKb });
  if (!indexResult.ok) return fail(indexResult.error, indexResult.message);

  // 4. Seed commit; record its sha as the diff base.
  const addResult = runGit(['add', '-A'], testKb);
  if (!addResult.ok) return addResult;
  const commitResult = runGit(
    ['-c', 'user.name=kb-eval', '-c', 'user.email=kb-eval@localhost', 'commit', '-m', `seed ${scenario.id}`],
    testKb,
  );
  if (!commitResult.ok) return commitResult;
  const seededShaResult = runGit(['rev-parse', 'HEAD'], testKb);
  if (!seededShaResult.ok) return seededShaResult;
  const seededSha = seededShaResult.data.trim();

  // 5. Read the target WK's text before the run.
  const manifestResult = loadManifest();
  if (!manifestResult.ok) return fail(manifestResult.error, manifestResult.message);
  const manifest = manifestResult.data;
  const wkTypeEntry = Object.values(manifest.types).find((t) => t.prefix === 'WK');
  if (!wkTypeEntry) return fail('MANIFEST_MISSING_WK', 'manifest has no WK-prefixed type entry');
  const wkRelPath = `${wkTypeEntry.directory}/${scenario.target_wk}.md`;
  const wkAbsPath = join(testKb, wkTypeEntry.directory, `${scenario.target_wk}.md`);

  const wkTextBeforeResult = readFileOrFail(wkAbsPath, 'TARGET_WK_READ_FAILED');
  if (!wkTextBeforeResult.ok) return wkTextBeforeResult;
  const wkTextBefore = wkTextBeforeResult.data;
  writeFileSync(join(opts.runDir, 'wk-before.md'), wkTextBefore);

  // 6. Install the condition.
  const roleTextResolved = resolveRoleText(condition, kbRoot);
  if (!roleTextResolved.ok) return roleTextResolved;
  const roleTextBlob = roleTextResolved.data.roleTextBlob;
  if (condition.install_command !== null) {
    const commandsDir = join(runHome, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, `${condition.install_command.name}.md`), roleTextResolved.data.commandBody ?? '');
  }

  for (const skill of condition.install_skills) {
    const installed = installSkill({
      srcDir: join(kbRoot, skill.path),
      destParentDir: join(testKb, '.claude', 'skills'),
      name: skill.name,
    });
    if (!installed.ok) return installed;
  }

  // 7. Exact-files refusal.
  const exactFiles = checkInstalledExactly([
    { dir: join(runHome, '.claude', 'commands'), expectedNames: condition.install_command !== null ? [`${condition.install_command.name}.md`] : [] },
    { dir: join(runHome, '.claude', 'skills'), expectedNames: [] },
    { dir: join(testKb, '.claude', 'commands'), expectedNames: [] },
    { dir: join(testKb, '.claude', 'skills'), expectedNames: condition.install_skills.map((s) => s.name) },
  ]);
  if (!exactFiles.ok) return exactFiles;

  // 8. Per-run MCP config.
  if (suite.mcp !== 'kb-wiki' && suite.mcp !== 'none') {
    return fail('INVALID_MCP_KIND', `suite.mcp must be 'kb-wiki' or 'none', got '${suite.mcp}'`);
  }
  const mcpKind: McpKind = suite.mcp;
  const mcpWrite = writeMcpConfig(join(runHome, 'mcp-config.json'), mcpKind);
  if (!mcpWrite.ok) return mcpWrite;

  // 9. Launch claude -p in the jail.
  const jailArgs = buildEvalJailArgs({
    systemRoots: opts.systemRoots,
    runHome,
    credentialsFile: opts.credentialsFile,
    testKb,
    kbRoot,
    cliPackageDir: opts.cliPackageDir,
    resolvConfRealpath: opts.resolvConfRealpath,
  });
  const claudeArgv = buildClaudeArgv({
    prompt: scenario.prompt,
    model: suite.model,
    budgetUsd: suite.budget_usd,
    mcpConfigPath: `${EVAL_HOME}/mcp-config.json`,
  });
  const cliBinaryJailPath = `${EVAL_CLI_PACKAGE_DIR}/${opts.cliBinaryRelPath}`;
  const command = ['bwrap', ...jailArgs, cliBinaryJailPath, ...claudeArgv];

  const launched = await opts.launch({
    command,
    captureDir: opts.runDir,
    timeoutMs: suite.timeout_sec * 1000,
    metadata: { cliVersion: opts.cliVersion, scenarioId: scenario.id, condition: condition.name, repeat: opts.repeat },
  });
  if (!launched.ok) return launched;

  // 10. Save the diff, status, and after-text; compute other changed wiki paths.
  const streamRawResult = readFileOrFail(join(opts.runDir, 'stream.jsonl'), 'STREAM_READ_FAILED');
  if (!streamRawResult.ok) return streamRawResult;
  const streamLines = streamRawResult.data.split('\n');

  const diffResult = runGit(['diff', seededSha], testKb);
  if (!diffResult.ok) return diffResult;
  writeFileSync(join(opts.runDir, 'diff.txt'), diffResult.data);

  const statusResult = runGit(['status', '--porcelain'], testKb);
  if (!statusResult.ok) return statusResult;
  writeFileSync(join(opts.runDir, 'status.txt'), statusResult.data);

  let wkTextAfter: string;
  try {
    wkTextAfter = readFileSync(wkAbsPath, 'utf8');
  } catch {
    wkTextAfter = '';
  }
  writeFileSync(join(opts.runDir, 'wk-after.md'), wkTextAfter);

  const otherChangedWikiPaths = parseGitDiff(diffResult.data)
    .map((c) => c.path)
    .filter((p) => isUnderWiki(p) && p !== wkRelPath);

  const scenarioDirShaResult = hashScenarioDir(opts.scenarioDir);
  if (!scenarioDirShaResult.ok) return scenarioDirShaResult;

  const pinsBase = {
    cliVersion: opts.cliVersion,
    roleTextBlob,
    scenarioDirSha256: scenarioDirShaResult.data,
    judgeModel: JUDGE_MODEL,
    judgePromptSha256: judgePromptSha256(opts.judgePromptTemplate),
    testKbBaselineSha: suite.baseline_sha,
    agentsBlock: { kbCommit: suite.agents_block.kb_commit, words: suite.agents_block.words },
    harnessTree: opts.harnessTree,
  };

  // 11. Validity.
  const validityResult = checkRunValidity({ exitCode: launched.data.exitCode, timedOut: launched.data.timedOut }, streamLines);
  if (!validityResult.ok) return validityResult;
  const validity = validityResult.data;

  if (!validity.valid) {
    const metrics: RunMetrics = {
      resolvable_escalated: 0,
      plan_compliance: { passed: 0, total: 0, failed: [] },
      cited_rows: 0,
      outcome: { passed: false, reason: `run invalid: ${validity.reason}` },
      reply_words: 0,
      model_id: extractInitModelId(streamLines),
      total_cost_usd: extractTotalCostUsd(streamLines),
      usage: undefined,
      validity,
      condition: condition.name,
      repeat: opts.repeat,
      scenario_id: scenario.id,
      cli_version: pinsBase.cliVersion,
      role_text_blob: pinsBase.roleTextBlob,
      scenario_dir_sha256: pinsBase.scenarioDirSha256,
      check_list_version: CHECK_LIST_VERSION,
      judge_model: pinsBase.judgeModel,
      judge_prompt_sha256: pinsBase.judgePromptSha256,
      test_kb_baseline_sha: pinsBase.testKbBaselineSha,
      agents_block: { kb_commit: pinsBase.agentsBlock.kbCommit, words: pinsBase.agentsBlock.words },
      harness_tree: pinsBase.harnessTree,
    };
    writeFileSync(join(opts.runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    return ok(metrics);
  }

  // 12. Valid run: parse the log, run checks, find added rows, lint, per-row citations/prose.
  const logResult = parseStreamLog(streamLines);
  if (!logResult.ok) return logResult;
  const log = logResult.data;

  const ctx: CheckContext = { log, diffText: diffResult.data, scenario, wkTextBefore, wkTextAfter, otherChangedWikiPaths };
  const checkOutcomes: CheckKindOutcome[] = [];
  for (const kind of scenario.checks) {
    const outcomeResult = runCheck(kind, ctx);
    if (!outcomeResult.ok) return outcomeResult;
    checkOutcomes.push({ kind, outcome: outcomeResult.data });
  }

  const beforeRowsResult = readResolutions(wkTextBefore);
  if (!beforeRowsResult.ok) return fail('RESOLUTIONS_PARSE_FAILED', beforeRowsResult.message);
  const afterRowsResult = readResolutions(wkTextAfter);
  if (!afterRowsResult.ok) return fail('RESOLUTIONS_PARSE_FAILED', afterRowsResult.message);
  const addedRows: ResolutionRow[] =
    afterRowsResult.data.length > beforeRowsResult.data.length ? afterRowsResult.data.slice(beforeRowsResult.data.length) : [];

  const lintResult = await lint({ dir: testKb });
  if (!lintResult.ok) return fail(lintResult.error, lintResult.message);
  const addedRowsLintClean = !lintResult.data.diagnostics.some((d) => d.severity === 'error' && d.file === wkRelPath);

  const rowEvals = addedRows.map((row) => ({
    row,
    citation: resolveCitations(parseCitations(row), testKb, manifest),
    prose: checkRowProse(row),
  }));
  const citedRowCount = rowEvals.filter((r) => r.citation.passed && r.prose.passed).length;

  // 13. Judge: resolvable class, eligible added rows only (max 3), each in a separate jail run.
  let judgeVerdict: JudgeVerdict = 'invalid';
  if (scenario.class === 'resolvable') {
    const eligible = rowEvals.filter((r) => r.citation.passed && r.prose.passed).slice(0, MAX_JUDGED_ROWS);
    let anyAnswers = false;
    let allInvalid = true;
    for (let i = 0; i < eligible.length; i++) {
      const { row, citation } = eligible[i];
      if (!citation.passed) continue;
      const citedFiles: CitedFile[] = citation.resolved.map((rc) => ({ id: rc.id, text: readFileSync(rc.absolutePath, 'utf8') }));
      const prompt = buildJudgePrompt(opts.judgePromptTemplate, {
        plantedQuestion: scenario.planted_question,
        choice: row.choice,
        citedFiles,
      });
      const judgeDir = join(opts.runDir, `judge-${i + 1}`);
      mkdirSync(judgeDir, { recursive: true });
      writeFileSync(join(judgeDir, 'prompt.txt'), prompt);

      let verdictResult = await runJudgeOnce(prompt, judgeDir, opts, suite, testKb, kbRoot);
      if (!verdictResult.ok) return verdictResult;
      if (verdictResult.data === 'invalid') {
        verdictResult = await runJudgeOnce(prompt, judgeDir, opts, suite, testKb, kbRoot);
        if (!verdictResult.ok) return verdictResult;
      }
      if (verdictResult.data === 'answers') anyAnswers = true;
      if (verdictResult.data !== 'invalid') allInvalid = false;
    }
    judgeVerdict = anyAnswers ? 'answers' : allInvalid ? 'invalid' : 'does-not-answer';
  }

  // 14. Outcome and metrics.
  const replyText = log.result?.text ?? '';
  const outcome = evaluateOutcome({
    scenario,
    replyText,
    addedRows,
    addedRowsLintClean,
    precheckPassedRowCount: citedRowCount,
    judgeVerdict,
  });

  const pins: RunMetricsPins = { ...pinsBase, modelId: log.modelId };
  const metrics = buildRunMetrics({
    scenario,
    replyText,
    checkOutcomes,
    citedRowCount,
    outcome,
    modelId: log.modelId,
    totalCostUsd: extractTotalCostUsd(streamLines),
    usage: log.result?.usage,
    validity,
    condition: condition.name,
    repeat: opts.repeat,
    pins,
  });

  writeFileSync(join(opts.runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  return ok(metrics);
}

function resetTestKbStep(testKb: string, baselineSha: string): EvalResult<void> {
  const resetResult = runGit(['reset', '--hard', baselineSha], testKb);
  if (!resetResult.ok) return resetResult;
  const cleanResult = runGit(['clean', '-fdx'], testKb);
  if (!cleanResult.ok) return cleanResult;
  return ok(undefined);
}

/** One judge jail call: fresh run home, MCP none, claude-sonnet-5, $2 budget, no allowed tools. */
async function runJudgeOnce(
  prompt: string,
  judgeDir: string,
  opts: RunScenarioOnceOpts,
  suite: Suite,
  testKb: string,
  kbRoot: string,
): Promise<EvalResult<JudgeVerdict>> {
  const judgeHome = join(judgeDir, 'home');
  mkdirSync(judgeHome, { recursive: true });

  const mcpWrite = writeMcpConfig(join(judgeHome, 'mcp-config.json'), 'none');
  if (!mcpWrite.ok) return mcpWrite;

  const jailArgs = buildEvalJailArgs({
    systemRoots: opts.systemRoots,
    runHome: judgeHome,
    credentialsFile: opts.credentialsFile,
    testKb,
    kbRoot,
    cliPackageDir: opts.cliPackageDir,
    resolvConfRealpath: opts.resolvConfRealpath,
  });
  const claudeArgv = buildClaudeArgv({
    prompt,
    model: JUDGE_MODEL,
    budgetUsd: JUDGE_BUDGET_USD,
    mcpConfigPath: `${EVAL_HOME}/mcp-config.json`,
    allowedTools: [],
  });
  const cliBinaryJailPath = `${EVAL_CLI_PACKAGE_DIR}/${opts.cliBinaryRelPath}`;
  const command = ['bwrap', ...jailArgs, cliBinaryJailPath, ...claudeArgv];

  const launched = await opts.launch({
    command,
    captureDir: judgeDir,
    timeoutMs: suite.timeout_sec * 1000,
    metadata: { cliVersion: opts.cliVersion },
  });
  if (!launched.ok) return launched;

  let streamRaw: string;
  try {
    streamRaw = readFileSync(join(judgeDir, 'stream.jsonl'), 'utf8');
  } catch {
    return ok('invalid');
  }
  const logResult = parseStreamLog(streamRaw.split('\n'));
  if (!logResult.ok) return ok('invalid');
  return ok(parseJudgeVerdict(logResult.data.result?.text ?? ''));
}
