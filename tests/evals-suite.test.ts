/**
 * WK-0237 slice B1d -- `runSuite`, the `--suite <name> [--scenario <id>]...
 * [--resume]` runner. Every test injects a fake launcher and a fake
 * jail-smoke runner (no real `claude`/`bwrap` call): a temp git repo stands
 * in for `test_kb`, a plain temp dir (or a second temp git repo, for the
 * missing-install-source case) stands in for the kb checkout, and a plain
 * temp dir stands in for `test_kb_data`. The committed fixture suite under
 * `tests/fixtures/evals/scenarios/test-suite/` covers the preflight
 * refusals that do not depend on suite shape (jail smoke, unknown scenario
 * id); the run-order, invalid-rerun, gating and result-set tests build
 * their own small suite dirs on disk, same pattern as
 * `evals-run-scenario.test.ts`'s ad hoc scenario dirs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LaunchOpts, LaunchResult } from '../evals/launch.js';
import type { RunJailSmokeFn } from '../evals/jail-smoke-runner.js';
import { fail, ok, type EvalResult } from '../evals/result.js';
import { computeResultSetId, formatSuiteTable, runSuite, type RunSuiteOpts } from '../evals/suite.js';

const FIXTURE_SUITE_DIR = join(__dirname, 'fixtures', 'evals', 'scenarios', 'test-suite');
const BUDGET_STREAM = readFileSync(
  join(__dirname, 'fixtures', 'evals', 'captures', 'wk0237-budget', 'stream.jsonl'),
  'utf8',
);
const JUDGE_TEMPLATE = '{{PLANTED_QUESTION}}\n{{CHOICE}}\n{{CITED_FILES}}\nVERDICT: answers / VERDICT: does-not-answer';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
}

function gitCommitAll(dir: string, message: string): string {
  git(['add', '-A'], dir);
  git(['-c', 'user.name=kb-eval-test', '-c', 'user.email=kb-eval-test@localhost', 'commit', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir).trim();
}

function setUpTestKb(workDir: string): { testKb: string; baselineSha: string } {
  const testKb = join(workDir, 'test_kb');
  gitInit(testKb);
  mkdirSync(join(testKb, 'wiki', 'issues'), { recursive: true });
  writeFileSync(join(testKb, 'wiki', 'issues', '.gitkeep'), '');
  const baselineSha = gitCommitAll(testKb, 'baseline');
  return { testKb, baselineSha };
}

function wkFixtureText(id: string, title: string): string {
  return [
    '---',
    `id: "${id}"`,
    `title: "${title}"`,
    'type: task',
    'status: inbox',
    'priority: low',
    'owner: "test"',
    'created: "2026-11-02"',
    'updated: "2026-11-02"',
    'area:',
    'initiative:',
    'tags: []',
    'repo_paths: []',
    'write_scope: []',
    'docs: []',
    'depends_on: []',
    'blocks: []',
    'related: []',
    '---',
    '',
    `# ${id}: ${title}`,
    '',
    '## Objective',
    '',
    'Fixture content only; not a real work item.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] none',
    '',
  ].join('\n');
}

interface ScenarioOverrides {
  id: string;
  target_wk: string;
  class?: 'resolvable' | 'operator-only';
  pass_threshold?: { passes: number; of: number };
}

/** Writes `<suiteDir>/<overrides.id>/scenario.json` plus a minimal seeded WK under its `records/issues/`. */
function writeScenarioDir(suiteDir: string, overrides: ScenarioOverrides): void {
  const scenarioDir = join(suiteDir, overrides.id);
  mkdirSync(join(scenarioDir, 'records', 'issues'), { recursive: true });
  writeFileSync(join(scenarioDir, 'records', 'issues', `${overrides.target_wk}.md`), wkFixtureText(overrides.target_wk, overrides.id));
  writeFileSync(
    join(scenarioDir, 'scenario.json'),
    JSON.stringify(
      {
        schema_version: 1,
        id: overrides.id,
        prompt: `/planner-eval ${overrides.target_wk}`,
        target_wk: overrides.target_wk,
        seeded_in: null,
        planted_question: 'Is this a fixture question?',
        class: overrides.class ?? 'resolvable',
        permitted_outcome: 'n/a (B1d order/gating test fixture)',
        checks: ['read-wk'],
        pass_threshold: overrides.pass_threshold ?? { passes: 1, of: 1 },
      },
      null,
      2,
    ),
  );
}

interface SuiteJsonOverrides {
  suite?: string;
  baseline_sha: string;
  repeats?: number;
  gated_condition?: string | null;
  conditions?: Array<{ name: string; install_command: unknown; install_skills: unknown[] }>;
  mcp?: string;
}

function writeSuiteJson(suiteDir: string, overrides: SuiteJsonOverrides): void {
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(
    join(suiteDir, 'suite.json'),
    JSON.stringify(
      {
        schema_version: 1,
        suite: overrides.suite ?? 'b1d-test-suite',
        baseline_sha: overrides.baseline_sha,
        agents_block: { kb_commit: '0000000', words: 10 },
        model: 'claude-sonnet-5',
        budget_usd: 1,
        timeout_sec: 60,
        mcp: overrides.mcp ?? 'none',
        repeats: overrides.repeats ?? 1,
        gated_condition: overrides.gated_condition ?? null,
        conditions: overrides.conditions ?? [{ name: 'no-install', install_command: null, install_skills: [] }],
      },
      null,
      2,
    ),
  );
}

function makeLaunch(
  responses: Array<{ stream: string; exitCode: number; timedOut?: boolean }>,
): { launch: (opts: LaunchOpts) => Promise<EvalResult<LaunchResult>>; calls: LaunchOpts[] } {
  const calls: LaunchOpts[] = [];
  const launch = vi.fn(async (opts: LaunchOpts): Promise<EvalResult<LaunchResult>> => {
    calls.push(opts);
    const response = responses[calls.length - 1] ?? responses[responses.length - 1];
    writeFileSync(join(opts.captureDir, 'stream.jsonl'), response.stream);
    writeFileSync(join(opts.captureDir, 'stderr.log'), '');
    const result: LaunchResult = {
      argv: opts.command,
      exitCode: response.exitCode,
      signal: null,
      timedOut: response.timedOut ?? false,
      wallTimeMs: 1,
    };
    writeFileSync(join(opts.captureDir, 'run.json'), JSON.stringify({ ...result, ...opts.metadata }, null, 2));
    return ok(result);
  });
  return { launch, calls };
}

function neverLaunch(): { launch: (opts: LaunchOpts) => Promise<EvalResult<LaunchResult>>; calls: LaunchOpts[] } {
  const calls: LaunchOpts[] = [];
  const launch = vi.fn(async (opts: LaunchOpts): Promise<EvalResult<LaunchResult>> => {
    calls.push(opts);
    throw new Error('launch should not have been called');
  });
  return { launch, calls };
}

const passJailSmoke: RunJailSmokeFn = async () => ok(undefined);

const VALID_STREAM = (modelId = 'claude-opus-5-5'): string =>
  [
    JSON.stringify({ type: 'system', subtype: 'init', model: modelId, session_id: 'sess' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01, usage: {} }),
  ].join('\n');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-eval-suite-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<RunSuiteOpts>): RunSuiteOpts {
  return {
    suiteDir: overrides.suiteDir as string,
    resultsRoot: overrides.resultsRoot ?? join(workDir, 'test_kb_data', 'evals', 'results'),
    scenarioIds: overrides.scenarioIds,
    resume: overrides.resume,
    testKb: overrides.testKb as string,
    kbRoot: overrides.kbRoot ?? join(workDir, 'kb-root-unused'),
    credentialsFile: '/does/not/matter/.credentials.json',
    cliPackageDir: '/does/not/matter/claude-code',
    cliBinaryRelPath: 'bin/claude',
    resolvConfRealpath: null,
    systemRoots: [],
    cliVersion: '2.1.281 (Claude Code)',
    judgePromptTemplate: overrides.judgePromptTemplate ?? JUDGE_TEMPLATE,
    launch: overrides.launch as RunSuiteOpts['launch'],
    runJailSmoke: overrides.runJailSmoke ?? passJailSmoke,
  };
}

describe('runSuite -- preflight', () => {
  it('refuses on a failing jail smoke and launches nothing', async () => {
    const { launch, calls } = neverLaunch();
    const failingSmoke: RunJailSmokeFn = async () => fail('CHECK_FAILED', 'jail-smoke required check failed: kb-wiki-empty');

    const result = await runSuite(
      baseOpts({
        suiteDir: FIXTURE_SUITE_DIR,
        testKb: join(workDir, 'unused-test-kb'),
        launch,
        runJailSmoke: failingSmoke,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('kb-wiki-empty');
    expect(calls.length).toBe(0);
  });

  it('refuses on an unknown --scenario id, naming it, and launches nothing', async () => {
    const { launch, calls } = neverLaunch();

    const result = await runSuite(
      baseOpts({
        suiteDir: FIXTURE_SUITE_DIR,
        testKb: join(workDir, 'unused-test-kb'),
        scenarioIds: ['does-not-exist'],
        launch,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('does-not-exist');
    expect(calls.length).toBe(0);
  });

  it('refuses when a condition install_skills dir is absent in the kb working tree, naming it', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9201' });
    writeSuiteJson(suiteDir, {
      baseline_sha: baselineSha,
      conditions: [{ name: 'with-resolve', install_command: null, install_skills: [{ name: 'resolve', path: 'contract/skills/resolve' }] }],
    });
    const kbRoot = join(workDir, 'kb-root-no-skill');
    mkdirSync(kbRoot, { recursive: true });

    const { launch, calls } = neverLaunch();
    const result = await runSuite(baseOpts({ suiteDir, testKb, kbRoot, launch }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('with-resolve');
    expect(result.message).toContain(join(kbRoot, 'contract', 'skills', 'resolve'));
    expect(calls.length).toBe(0);
  });

  it('refuses when a condition install_command git ref:path is missing, naming it', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9202' });
    writeSuiteJson(suiteDir, {
      baseline_sha: baselineSha,
      conditions: [{ name: 'v2', install_command: { name: 'planner-eval', git_ref: 'HEAD', path: 'contract/roles/planner.md' }, install_skills: [] }],
    });
    const kbRoot = join(workDir, 'kb-root-empty-git');
    gitInit(kbRoot);
    writeFileSync(join(kbRoot, 'README.md'), 'placeholder');
    gitCommitAll(kbRoot, 'init');

    const { launch, calls } = neverLaunch();
    const result = await runSuite(baseOpts({ suiteDir, testKb, kbRoot, launch }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('v2');
    expect(result.message).toContain('contract/roles/planner.md');
    expect(calls.length).toBe(0);
  });
});

describe('runSuite -- run order (15.4: scenario, then repeat, then condition)', () => {
  it('calls the launcher in scenario -> repeat -> condition order for 2 conditions x 3 repeats', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9301' });
    writeSuiteJson(suiteDir, {
      baseline_sha: baselineSha,
      repeats: 3,
      conditions: [
        { name: 'c1', install_command: null, install_skills: [] },
        { name: 'c2', install_command: null, install_skills: [] },
      ],
    });

    const { launch, calls } = makeLaunch([{ stream: VALID_STREAM(), exitCode: 0 }]);

    const result = await runSuite(baseOpts({ suiteDir, testKb, launch }));

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(6);
    const sequence = calls.map((c) => ({ condition: c.metadata?.condition, repeat: c.metadata?.repeat }));
    expect(sequence).toEqual([
      { condition: 'c1', repeat: 1 },
      { condition: 'c2', repeat: 1 },
      { condition: 'c1', repeat: 2 },
      { condition: 'c2', repeat: 2 },
      { condition: 'c1', repeat: 3 },
      { condition: 'c2', repeat: 3 },
    ]);
  });
});

describe('runSuite -- invalid run re-run (15.2)', () => {
  it('re-runs an invalid run once and the re-run replaces it when the re-run is valid', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9401' });
    writeSuiteJson(suiteDir, { baseline_sha: baselineSha, gated_condition: 'c1', conditions: [{ name: 'c1', install_command: null, install_skills: [] }] });

    const { launch, calls } = makeLaunch([
      { stream: BUDGET_STREAM, exitCode: 1 },
      { stream: VALID_STREAM(), exitCode: 0 },
    ]);

    const result = await runSuite(baseOpts({ suiteDir, testKb, launch }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBe(2);

    const resultSetDir = result.data.resultSetDir;
    expect(existsSync(join(resultSetDir, 's1', 'c1-r1', 'metrics.json'))).toBe(true);
    expect(existsSync(join(resultSetDir, 's1', 'c1-r1-rerun', 'metrics.json'))).toBe(true);

    const originalMetrics = JSON.parse(readFileSync(join(resultSetDir, 's1', 'c1-r1', 'metrics.json'), 'utf8'));
    expect(originalMetrics.validity).toEqual({ valid: false, reason: 'budget-stop' });

    const rerunMetrics = JSON.parse(readFileSync(join(resultSetDir, 's1', 'c1-r1-rerun', 'metrics.json'), 'utf8'));
    expect(rerunMetrics.validity).toEqual({ valid: true });

    const stat = result.data.summary.stats.find((s) => s.scenarioId === 's1' && s.condition === 'c1');
    expect(stat?.validRuns).toBe(1);
    expect(stat?.invalidCount).toBe(0);
  });

  it('leaves the repeat invalid and the gate incomplete when the re-run is also invalid', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9402', pass_threshold: { passes: 1, of: 1 } });
    writeSuiteJson(suiteDir, { baseline_sha: baselineSha, gated_condition: 'c1', conditions: [{ name: 'c1', install_command: null, install_skills: [] }] });

    const { launch, calls } = makeLaunch([
      { stream: BUDGET_STREAM, exitCode: 1 },
      { stream: BUDGET_STREAM, exitCode: 1 },
    ]);

    const result = await runSuite(baseOpts({ suiteDir, testKb, launch }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBe(2);
    expect(result.data.summary.gateVerdict).toBe('incomplete');

    const stat = result.data.summary.stats.find((s) => s.scenarioId === 's1' && s.condition === 'c1');
    expect(stat?.invalidCount).toBe(1);
    expect(stat?.validRuns).toBe(0);
  });
});

describe('runSuite -- --scenario filtering and the gate', () => {
  it('reports the gate as partial on a filtered run of a gated suite', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9501', pass_threshold: { passes: 1, of: 1 } });
    writeScenarioDir(suiteDir, { id: 's2', target_wk: 'WK-9502', pass_threshold: { passes: 1, of: 1 } });
    writeSuiteJson(suiteDir, { baseline_sha: baselineSha, gated_condition: 'c1', conditions: [{ name: 'c1', install_command: null, install_skills: [] }] });

    const { launch, calls } = makeLaunch([{ stream: VALID_STREAM(), exitCode: 0 }]);

    const result = await runSuite(baseOpts({ suiteDir, testKb, scenarioIds: ['s1'], launch }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBe(1);
    expect(result.data.summary.gateVerdict).toBe('partial');
    expect(result.data.summary.stats.some((s) => s.scenarioId === 's2')).toBe(false);
  });
});

describe('computeResultSetId', () => {
  const basePins = {
    suite: 'b1d-test-suite',
    scenarioDirHashes: ['aaa'],
    conditionRoleTextBlobs: ['bbb'],
    judgePromptSha256: 'ccc',
    checkListVersion: '1',
    baselineSha: '0'.repeat(40),
    agentsBlock: { kb_commit: '0000000', words: 10 },
    model: 'claude-sonnet-5',
    cliVersion: '2.1.281 (Claude Code)',
    selectedScenarioIdsSorted: ['s1'],
  };

  it('is stable for identical pins', () => {
    expect(computeResultSetId(basePins)).toBe(computeResultSetId({ ...basePins }));
  });

  it('changes when a scenario dir hash changes', () => {
    const changed = computeResultSetId({ ...basePins, scenarioDirHashes: ['different'] });
    expect(changed).not.toBe(computeResultSetId(basePins));
  });

  it('changes when the judge prompt hash changes', () => {
    const changed = computeResultSetId({ ...basePins, judgePromptSha256: 'different' });
    expect(changed).not.toBe(computeResultSetId(basePins));
  });
});

describe('runSuite -- result set dir and --resume', () => {
  it('refuses an existing result set dir without --resume, and resumes (no new launches) with it', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9601' });
    writeSuiteJson(suiteDir, { baseline_sha: baselineSha });
    const resultsRoot = join(workDir, 'test_kb_data', 'evals', 'results');

    const { launch: launch1, calls: calls1 } = makeLaunch([{ stream: VALID_STREAM(), exitCode: 0 }]);
    const first = await runSuite(baseOpts({ suiteDir, testKb, resultsRoot, launch: launch1 }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(calls1.length).toBe(1);

    const { launch: launch2, calls: calls2 } = neverLaunch();
    const second = await runSuite(baseOpts({ suiteDir, testKb, resultsRoot, launch: launch2 }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain(first.data.resultSetDir);
    expect(calls2.length).toBe(0);

    const { launch: launch3, calls: calls3 } = neverLaunch();
    const resumed = await runSuite(baseOpts({ suiteDir, testKb, resultsRoot, resume: true, launch: launch3 }));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.resultSetDir).toBe(first.data.resultSetDir);
    expect(calls3.length).toBe(0);
  });

  it('writes summary.json with summarizeSuite output, pins, and start/end timestamps', async () => {
    const { testKb, baselineSha } = setUpTestKb(workDir);
    const suiteDir = join(workDir, 'suite');
    writeScenarioDir(suiteDir, { id: 's1', target_wk: 'WK-9701' });
    writeSuiteJson(suiteDir, { baseline_sha: baselineSha, suite: 'summary-test-suite' });

    const { launch } = makeLaunch([{ stream: VALID_STREAM(), exitCode: 0 }]);
    const result = await runSuite(baseOpts({ suiteDir, testKb, launch }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summaryPath = join(result.data.resultSetDir, 'summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    expect(summary.stats.length).toBeGreaterThan(0);
    expect(summary.gateVerdict).toBe('n/a');
    expect(summary.pins.suite).toBe('summary-test-suite');
    expect(summary.pins.resultSetId).toBe(result.data.resultSetId);
    expect(typeof summary.startedAt).toBe('string');
    expect(typeof summary.endedAt).toBe('string');

    expect(existsSync(join(result.data.resultSetDir, 's1', 'no-install-r1', 'metrics.json'))).toBe(true);

    const table = formatSuiteTable(result.data.summary);
    expect(table).toContain('gate: n/a');
  });
});
