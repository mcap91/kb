/**
 * `--suite <name> [--scenario <id>]... [--resume]` runner (WK-0237 slice
 * B1d; scope 15.3, 15.4; 15.2 invalid handling; operator ruling "3 scenarios
 * first", WK-0237 Notes 2026-11-02, makes `--scenario` filtering required).
 * Reuses `runScenarioOnce` (per-run pipeline), `summarizeSuite` (gate
 * verdict), `resolveRoleText` and `hashScenarioDir` (result-set pins),
 * `loadSuite`/`loadSuiteScenarios` (the loader) and the injected launcher
 * and jail-smoke runner — nothing here reimplements them.
 *
 * Preflight (before any run): (1) the jail smoke, refusing on any failure;
 * (2) load the suite and its scenarios; (3) an unknown `--scenario` id,
 * named; (4) a missing install source for any condition, named. Only then
 * is the result-set id computed and the result-set dir created/checked.
 *
 * Run order (15.4): for each selected scenario in suite order, for repeat
 * 1..suite.repeats, for each condition in suite order:
 * `<resultSetDir>/<scenario>/<condition>-r<repeat>/`. An invalid run is
 * re-run exactly once into `<condition>-r<repeat>-rerun/`, which replaces it
 * in the summary; a second invalid leaves the repeat invalid.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { judgePromptSha256 } from './judge.js';
import type { RunJailSmokeFn } from './jail-smoke-runner.js';
import { CHECK_LIST_VERSION, type RunMetrics, type SuiteRunRecord, type SuiteSummary, summarizeSuite } from './metrics.js';
import { fail, ok, type EvalResult } from './result.js';
import { resolveRoleText, runScenarioOnce, type LaunchFn, type SuiteCondition } from './run-scenario.js';
import { hashScenarioDir } from './scenario-hash.js';
import { loadSuite, loadSuiteScenarios, type Scenario, type Suite } from './scenario-schema.js';

export interface RunSuiteOpts {
  /** `evals/scenarios/<name>/` — holds `suite.json` and one dir per scenario. */
  suiteDir: string;
  /** `<test_kb_data>/evals/results` — the suite's own result sets land under `<resultsRoot>/<suite.suite>/<result_set_id>/`. */
  resultsRoot: string;
  /** `--scenario` filter; undefined or empty runs every scenario in the suite. */
  scenarioIds?: string[];
  /** Resumes an existing result-set dir, skipping any run/rerun whose `metrics.json` already exists. */
  resume?: boolean;
  testKb: string;
  kbRoot: string;
  credentialsFile: string;
  cliPackageDir: string;
  cliBinaryRelPath: string;
  resolvConfRealpath: string | null;
  systemRoots: readonly string[];
  cliVersion: string;
  judgePromptTemplate: string;
  launch: LaunchFn;
  /** Preflight step 1 — refuses the whole run on any failure, naming it. Injected so tests never spawn a real bwrap. */
  runJailSmoke: RunJailSmokeFn;
}

export interface SuiteSummaryRecord extends SuiteSummary {
  pins: {
    suite: string;
    cliVersion: string;
    judgePromptSha256: string;
    checkListVersion: string;
    baselineSha: string;
    agentsBlock: { kb_commit: string; words: number };
    model: string;
    resultSetId: string;
  };
  startedAt: string;
  endedAt: string;
}

export interface RunSuiteResult {
  resultSetDir: string;
  resultSetId: string;
  summary: SuiteSummaryRecord;
}

export interface ResultSetPinInput {
  suite: string;
  scenarioDirHashes: string[];
  conditionRoleTextBlobs: string[];
  judgePromptSha256: string;
  checkListVersion: string;
  baselineSha: string;
  agentsBlock: { kb_commit: string; words: number };
  model: string;
  cliVersion: string;
  /** Must already be sorted by the caller — the hash is sensitive to order. */
  selectedScenarioIdsSorted: string[];
}

/**
 * sha256 over a canonical JSON rendering of the pins that define a result
 * set, first 16 hex chars (WK-0237 scope 15.4: "a changed hash starts a new
 * result set"). Deterministic because every field is built from the same
 * fixed key order on every call — no object-key reordering ever enters the
 * hash.
 */
export function computeResultSetId(input: ResultSetPinInput): string {
  const canonical = JSON.stringify({
    suite: input.suite,
    scenarioDirHashes: input.scenarioDirHashes,
    conditionRoleTextBlobs: input.conditionRoleTextBlobs,
    judgePromptSha256: input.judgePromptSha256,
    checkListVersion: input.checkListVersion,
    baselineSha: input.baselineSha,
    agentsBlock: { kb_commit: input.agentsBlock.kb_commit, words: input.agentsBlock.words },
    model: input.model,
    cliVersion: input.cliVersion,
    selectedScenarioIds: input.selectedScenarioIdsSorted,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Renders a short per-scenario/condition table plus the gate verdict (WK-0237 scope 15.4's "print a short ... table"). */
export function formatSuiteTable(summary: SuiteSummary): string {
  const lines: string[] = ['scenario\tcondition\tpasses/of\tinvalid'];
  for (const stat of summary.stats) {
    lines.push(`${stat.scenarioId}\t${stat.condition}\t${stat.passes}/${stat.validRuns}\t${stat.invalidCount}`);
  }
  lines.push(`gate: ${summary.gateVerdict}`);
  return lines.join('\n');
}

interface Preflighted {
  suite: Suite;
  allScenarios: Scenario[];
  selected: Scenario[];
  roleTextBlobsByCondition: Map<string, string>;
}

async function preflight(opts: RunSuiteOpts): Promise<EvalResult<Preflighted>> {
  const smoke = await opts.runJailSmoke();
  if (!smoke.ok) {
    return fail('PREFLIGHT_JAIL_SMOKE_FAILED', `jail smoke failed: ${smoke.message}`);
  }

  const suiteResult = loadSuite(opts.suiteDir);
  if (!suiteResult.ok) return suiteResult;
  const suite = suiteResult.data;

  const scenariosResult = loadSuiteScenarios(opts.suiteDir);
  if (!scenariosResult.ok) return scenariosResult;
  const allScenarios = scenariosResult.data;

  const requestedIds = opts.scenarioIds ?? [];
  let selected = allScenarios;
  if (requestedIds.length > 0) {
    const known = new Set(allScenarios.map((s) => s.id));
    const unknown = requestedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return fail('UNKNOWN_SCENARIO_ID', `unknown --scenario id(s): ${unknown.join(', ')}`);
    }
    const wanted = new Set(requestedIds);
    selected = allScenarios.filter((s) => wanted.has(s.id));
  }

  const roleTextBlobsByCondition = new Map<string, string>();
  for (const condition of suite.conditions) {
    for (const skill of condition.install_skills) {
      const skillDir = join(opts.kbRoot, skill.path);
      if (!existsSync(skillDir)) {
        return fail('INSTALL_SOURCE_MISSING', `condition '${condition.name}': install_skills dir missing: ${skillDir}`);
      }
    }
    const resolved = resolveRoleText(condition, opts.kbRoot);
    if (!resolved.ok) {
      return fail('INSTALL_SOURCE_MISSING', `condition '${condition.name}': ${resolved.message}`);
    }
    roleTextBlobsByCondition.set(condition.name, resolved.data.roleTextBlob);
  }

  return ok({ suite, allScenarios, selected, roleTextBlobsByCondition });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runDirFor(resultSetDir: string, scenarioId: string, condition: SuiteCondition, repeat: number): string {
  return join(resultSetDir, scenarioId, `${condition.name}-r${repeat}`);
}

function rerunDirFor(resultSetDir: string, scenarioId: string, condition: SuiteCondition, repeat: number): string {
  return join(resultSetDir, scenarioId, `${condition.name}-r${repeat}-rerun`);
}

async function runOrResume(
  runDir: string,
  resume: boolean | undefined,
  run: () => Promise<EvalResult<RunMetrics>>,
): Promise<EvalResult<RunMetrics>> {
  const metricsPath = join(runDir, 'metrics.json');
  if (resume && existsSync(metricsPath)) {
    try {
      return ok(JSON.parse(readFileSync(metricsPath, 'utf8')) as RunMetrics);
    } catch (err) {
      return fail('RESUME_METRICS_READ_FAILED', `failed to read ${metricsPath}: ${describeError(err)}`);
    }
  }
  return run();
}

/**
 * Runs every selected scenario of one suite, all repeats and conditions, in
 * 15.4 order, writing one `metrics.json` per run (and per invalid-run
 * re-run) under a result-set dir keyed by `computeResultSetId`, then a
 * `summary.json` holding `summarizeSuite`'s output plus the pins and
 * timestamps.
 */
export async function runSuite(opts: RunSuiteOpts): Promise<EvalResult<RunSuiteResult>> {
  const preflighted = await preflight(opts);
  if (!preflighted.ok) return preflighted;
  const { suite, allScenarios, selected, roleTextBlobsByCondition } = preflighted.data;

  const scenarioDirHashes: string[] = [];
  for (const scenario of selected) {
    const hashResult = hashScenarioDir(join(opts.suiteDir, scenario.id));
    if (!hashResult.ok) return hashResult;
    scenarioDirHashes.push(hashResult.data);
  }

  const judgePromptSha = judgePromptSha256(opts.judgePromptTemplate);

  const resultSetId = computeResultSetId({
    suite: suite.suite,
    scenarioDirHashes,
    conditionRoleTextBlobs: suite.conditions.map((c) => roleTextBlobsByCondition.get(c.name) as string),
    judgePromptSha256: judgePromptSha,
    checkListVersion: CHECK_LIST_VERSION,
    baselineSha: suite.baseline_sha,
    agentsBlock: suite.agents_block,
    model: suite.model,
    cliVersion: opts.cliVersion,
    selectedScenarioIdsSorted: [...selected.map((s) => s.id)].sort(),
  });

  const resultSetDir = join(opts.resultsRoot, suite.suite, resultSetId);
  if (existsSync(resultSetDir) && !opts.resume) {
    return fail('RESULT_SET_EXISTS', `result set dir already exists: ${resultSetDir} (pass --resume to continue it)`);
  }
  mkdirSync(resultSetDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const runs: SuiteRunRecord[] = [];

  for (const scenario of selected) {
    const scenarioDir = join(opts.suiteDir, scenario.id);
    for (let repeat = 1; repeat <= suite.repeats; repeat++) {
      for (const condition of suite.conditions) {
        const runDir = runDirFor(resultSetDir, scenario.id, condition, repeat);
        const runResult = await runOrResume(runDir, opts.resume, () =>
          runScenarioOnce({
            suite,
            scenario,
            scenarioDir,
            condition,
            repeat,
            runDir,
            testKb: opts.testKb,
            kbRoot: opts.kbRoot,
            credentialsFile: opts.credentialsFile,
            cliPackageDir: opts.cliPackageDir,
            cliBinaryRelPath: opts.cliBinaryRelPath,
            resolvConfRealpath: opts.resolvConfRealpath,
            systemRoots: opts.systemRoots,
            cliVersion: opts.cliVersion,
            judgePromptTemplate: opts.judgePromptTemplate,
            launch: opts.launch,
          }),
        );
        if (!runResult.ok) return runResult;

        let finalMetrics = runResult.data;
        if (!finalMetrics.validity.valid) {
          const rerunDir = rerunDirFor(resultSetDir, scenario.id, condition, repeat);
          const rerunResult = await runOrResume(rerunDir, opts.resume, () =>
            runScenarioOnce({
              suite,
              scenario,
              scenarioDir,
              condition,
              repeat,
              runDir: rerunDir,
              testKb: opts.testKb,
              kbRoot: opts.kbRoot,
              credentialsFile: opts.credentialsFile,
              cliPackageDir: opts.cliPackageDir,
              cliBinaryRelPath: opts.cliBinaryRelPath,
              resolvConfRealpath: opts.resolvConfRealpath,
              systemRoots: opts.systemRoots,
              cliVersion: opts.cliVersion,
              judgePromptTemplate: opts.judgePromptTemplate,
              launch: opts.launch,
            }),
          );
          if (!rerunResult.ok) return rerunResult;
          finalMetrics = rerunResult.data;
        }

        runs.push({
          scenarioId: scenario.id,
          condition: condition.name,
          repeat,
          valid: finalMetrics.validity.valid,
          outcomePassed: finalMetrics.outcome.passed,
        });
      }
    }
  }

  const endedAt = new Date().toISOString();

  const summary = summarizeSuite(
    runs,
    {
      gatedCondition: suite.gated_condition,
      scenarios: allScenarios.map((s) => ({ id: s.id, passThreshold: s.pass_threshold })),
    },
    selected.map((s) => s.id),
  );

  const summaryRecord: SuiteSummaryRecord = {
    ...summary,
    pins: {
      suite: suite.suite,
      cliVersion: opts.cliVersion,
      judgePromptSha256: judgePromptSha,
      checkListVersion: CHECK_LIST_VERSION,
      baselineSha: suite.baseline_sha,
      agentsBlock: suite.agents_block,
      model: suite.model,
      resultSetId,
    },
    startedAt,
    endedAt,
  };

  writeFileSync(join(resultSetDir, 'summary.json'), JSON.stringify(summaryRecord, null, 2));

  console.log(formatSuiteTable(summary));

  return ok({ resultSetDir, resultSetId, summary: summaryRecord });
}
