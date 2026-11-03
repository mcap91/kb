/**
 * WK-0237 slice B1c — `runScenarioOnce`, one scored run end to end. Every
 * test injects a fake launcher (no real `claude`/`bwrap` call): a temp git
 * repo stands in for `test_kb`, a second temp git repo stands in for the kb
 * checkout (installs), and the committed fixture suite under
 * `tests/fixtures/evals/scenarios/` covers the invalid-run path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LaunchOpts, LaunchResult } from '../evals/launch.js';
import { ok, type EvalResult } from '../evals/result.js';
import { runScenarioOnce, type RunScenarioOnceOpts } from '../evals/run-scenario.js';
import { loadScenario, loadSuite, type Scenario, type Suite } from '../evals/scenario-schema.js';

const FIXTURE_SUITE_DIR = join(__dirname, 'fixtures', 'evals', 'scenarios', 'test-suite');
const BUDGET_STREAM = readFileSync(
  join(__dirname, 'fixtures', 'evals', 'captures', 'wk0237-budget', 'stream.jsonl'),
  'utf8',
);

const JUDGE_TEMPLATE = '{{PLANTED_QUESTION}}\n{{CHOICE}}\n{{CITED_FILES}}\nVERDICT: answers / VERDICT: does-not-answer';
const ESCALATION_JUDGE_TEMPLATE = '{{PLANTED_QUESTION}}\n{{REPLY_TEXT}}\nVERDICT: escalated / VERDICT: not-escalated';

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

/** A fake `launch()`: writes stream.jsonl/stderr.log/run.json into `captureDir`, running `onCall` first for any side effect (e.g. simulating the agent's edit to test_kb). */
function makeLaunch(
  responses: Array<{ stream: string; exitCode: number; timedOut?: boolean; onCall?: () => void }>,
): { launch: (opts: LaunchOpts) => Promise<EvalResult<LaunchResult>>; calls: LaunchOpts[] } {
  const calls: LaunchOpts[] = [];
  const launch = vi.fn(async (opts: LaunchOpts): Promise<EvalResult<LaunchResult>> => {
    calls.push(opts);
    const response = responses[calls.length - 1] ?? responses[responses.length - 1];
    response.onCall?.();
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

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-eval-run-scenario-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<RunScenarioOnceOpts>): RunScenarioOnceOpts {
  return {
    suite: overrides.suite as Suite,
    scenario: overrides.scenario as Scenario,
    scenarioDir: overrides.scenarioDir as string,
    condition: overrides.condition ?? { name: 'no-install', install_command: null, install_skills: [] },
    repeat: overrides.repeat ?? 1,
    runDir: overrides.runDir as string,
    testKb: overrides.testKb as string,
    kbRoot: overrides.kbRoot ?? '/does/not/matter',
    credentialsFile: '/does/not/matter/.credentials.json',
    cliPackageDir: '/does/not/matter/claude-code',
    cliBinaryRelPath: 'bin/claude',
    resolvConfRealpath: null,
    systemRoots: [],
    cliVersion: '2.1.281 (Claude Code)',
    judgePromptTemplate: JUDGE_TEMPLATE,
    escalationJudgePromptTemplate: overrides.escalationJudgePromptTemplate ?? ESCALATION_JUDGE_TEMPLATE,
    harnessTree: overrides.harnessTree ?? 'd'.repeat(64),
    launch: overrides.launch as RunScenarioOnceOpts['launch'],
  };
}

describe('runScenarioOnce — invalid run (budget fixture)', () => {
  it('writes metrics with validity invalid/budget-stop and never calls the judge', async () => {
    const testKb = join(workDir, 'test_kb');
    gitInit(testKb);
    mkdirSync(join(testKb, 'wiki', 'issues'), { recursive: true });
    writeFileSync(join(testKb, 'wiki', 'issues', '.gitkeep'), '');
    const baselineSha = gitCommitAll(testKb, 'baseline');

    const suiteResult = loadSuite(FIXTURE_SUITE_DIR);
    expect(suiteResult.ok).toBe(true);
    if (!suiteResult.ok) return;
    const suite: Suite = { ...suiteResult.data, baseline_sha: baselineSha };

    const scenarioDir = join(FIXTURE_SUITE_DIR, 'demo-scenario');
    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const runDir = join(workDir, 'run');
    const { launch, calls } = makeLaunch([{ stream: BUDGET_STREAM, exitCode: 1 }]);

    const result = await runScenarioOnce(
      baseOpts({
        suite,
        scenario: scenarioResult.data,
        scenarioDir,
        condition: suite.conditions[0],
        runDir,
        testKb,
        launch,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.validity).toEqual({ valid: false, reason: 'budget-stop' });
    expect(result.data.outcome.passed).toBe(false);
    expect(calls.length).toBe(1);

    expect(existsSync(join(runDir, 'metrics.json'))).toBe(true);
    const written = JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8'));
    expect(written.validity).toEqual({ valid: false, reason: 'budget-stop' });
    expect(written.model_id).toBe('claude-opus-5-5');
    expect(result.data.model_id).toBe('claude-opus-5-5');
    expect(existsSync(join(runDir, 'judge-1'))).toBe(false);
  });

  it('keeps model_id null when the stream has no parseable init event', async () => {
    const testKb = join(workDir, 'test_kb');
    gitInit(testKb);
    mkdirSync(join(testKb, 'wiki', 'issues'), { recursive: true });
    writeFileSync(join(testKb, 'wiki', 'issues', '.gitkeep'), '');
    const baselineSha = gitCommitAll(testKb, 'baseline');

    const suiteResult = loadSuite(FIXTURE_SUITE_DIR);
    expect(suiteResult.ok).toBe(true);
    if (!suiteResult.ok) return;
    const suite: Suite = { ...suiteResult.data, baseline_sha: baselineSha };

    const scenarioDir = join(FIXTURE_SUITE_DIR, 'demo-scenario');
    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const runDir = join(workDir, 'run');
    const noInitStream = 'not valid json\n{"type":"result","subtype":"error_max_budget_usd","is_error":true}\n';
    const { launch, calls } = makeLaunch([{ stream: noInitStream, exitCode: 1 }]);

    const result = await runScenarioOnce(
      baseOpts({
        suite,
        scenario: scenarioResult.data,
        scenarioDir,
        condition: suite.conditions[0],
        runDir,
        testKb,
        launch,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.validity).toEqual({ valid: false, reason: 'budget-stop' });
    expect(calls.length).toBe(1);
    expect(result.data.model_id).toBeNull();

    const written = JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8'));
    expect(written.model_id).toBeNull();
  });
});

describe('runScenarioOnce — resolvable run with a cited, prose-complete added row', () => {
  function setUpScenario(): { scenarioDir: string; testKb: string; kbRoot: string; wkAbsPath: string; wkTextBefore: string } {
    const testKb = join(workDir, 'test_kb');
    gitInit(testKb);
    mkdirSync(join(testKb, 'wiki', 'issues'), { recursive: true });
    writeFileSync(join(testKb, 'wiki', 'issues', '.gitkeep'), '');

    const scenarioDir = join(workDir, 'scenario');
    mkdirSync(join(scenarioDir, 'records', 'issues'), { recursive: true });
    mkdirSync(join(scenarioDir, 'records', 'decisions'), { recursive: true });

    const wkTextBefore = [
      '---',
      'id: "WK-9101"',
      'title: "Run-scenario fixture WK"',
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
      '# WK-9101: Run-scenario fixture WK',
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
    writeFileSync(join(scenarioDir, 'records', 'issues', 'WK-9101.md'), wkTextBefore);

    writeFileSync(
      join(scenarioDir, 'records', 'decisions', 'DEC-0901.md'),
      [
        '---',
        'id: "DEC-0901"',
        'title: "Fixture decision for run-scenario tests"',
        'status: accepted',
        'date: "2026-11-02"',
        'owners: ["test"]',
        '---',
        '',
        '# DEC-0901: Fixture decision',
        '',
        'Billing reaches the ledger through a direct import, not an MCP server.',
        '',
      ].join('\n'),
    );

    writeFileSync(
      join(scenarioDir, 'scenario.json'),
      JSON.stringify(
        {
          schema_version: 1,
          id: 'fixture-resolvable',
          prompt: '/planner-eval WK-9101',
          target_wk: 'WK-9101',
          seeded_in: null,
          planted_question: 'Should billing reach the ledger through an MCP server or a direct import?',
          class: 'resolvable',
          permitted_outcome: 'A Resolutions row cites DEC-0901.',
          checks: ['read-wk'],
          pass_threshold: { passes: 3, of: 3 },
        },
        null,
        2,
      ),
    );

    const kbRoot = join(workDir, 'kb-root');
    gitInit(kbRoot);
    mkdirSync(join(kbRoot, 'contract', 'roles'), { recursive: true });
    writeFileSync(join(kbRoot, 'contract', 'roles', 'planner.md'), 'PLANNER ROLE TEXT V2');
    mkdirSync(join(kbRoot, 'contract', 'skills', 'resolve'), { recursive: true });
    writeFileSync(join(kbRoot, 'contract', 'skills', 'resolve', 'SKILL.md'), 'RESOLVE SKILL BODY');
    gitCommitAll(kbRoot, 'init kb-root');

    return { scenarioDir, testKb, kbRoot, wkAbsPath: join(testKb, 'wiki', 'issues', 'WK-9101.md'), wkTextBefore };
  }

  function appendedWkText(wkTextBefore: string, citation: string): string {
    return (
      wkTextBefore +
      [
        '## Resolutions',
        '',
        '| # | date | seat | question | searched | evidence | options | choice | reason | cold check |',
        '|---|---|---|---|---|---|---|---|---|---|',
        `| 1 | 2026-11-02 | planner | Should billing reach the ledger through MCP or import? | ${citation} | ${citation} settles the question | mcp; import | ${citation} | ${citation} answers directly | pass |`,
        '',
      ].join('\n')
    );
  }

  const MAIN_STREAM = (replyText: string) =>
    [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'sess-main' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/eval/test_kb/wiki/issues/WK-9101.md' } }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: replyText,
        total_cost_usd: 0.02,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ].join('\n');

  const JUDGE_STREAM_ANSWERS = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 'sess-judge' }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'VERDICT: answers\nThe cited decision settles it.',
      total_cost_usd: 0.001,
      usage: {},
    }),
  ].join('\n');

  const escalationStream = (verdict: 'escalated' | 'not-escalated', text: string) =>
    [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 'sess-escalation-judge' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: `VERDICT: ${verdict}\n${text}`,
        total_cost_usd: 0.001,
        usage: {},
      }),
    ].join('\n');
  const ESCALATION_STREAM_NOT_ESCALATED = escalationStream('not-escalated', 'The reply already decided and recorded the answer.');
  const ESCALATION_STREAM_ESCALATED = escalationStream('escalated', 'The reply asks the operator to approve the row.');
  const ESCALATION_STREAM_INVALID = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 'sess-escalation-judge' }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'I am not sure.',
      total_cost_usd: 0.001,
      usage: {},
    }),
  ].join('\n');

  it('calls the judge in a separate run with MCP none and no allowed tools, and records the "answers" verdict', async () => {
    const { scenarioDir, testKb, kbRoot, wkAbsPath, wkTextBefore } = setUpScenario();
    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const kbRootSha = git(['rev-parse', 'HEAD'], kbRoot).trim();

    const baselineSha = gitCommitAll(testKb, 'baseline');

    const suite: Suite = {
      schema_version: 1,
      suite: 'fixture-suite',
      baseline_sha: baselineSha,
      agents_block: { kb_commit: '1234567', words: 42 },
      model: 'claude-opus-5-5',
      budget_usd: 2,
      timeout_sec: 60,
      mcp: 'kb-wiki',
      repeats: 1,
      gated_condition: null,
      conditions: [],
    };

    const condition = {
      name: 'v2',
      install_command: { name: 'planner-eval', git_ref: kbRootSha, path: 'contract/roles/planner.md' },
      install_skills: [{ name: 'resolve', path: 'contract/skills/resolve' }],
    };

    const runDir = join(workDir, 'run');
    const { launch, calls } = makeLaunch([
      { stream: MAIN_STREAM('Added a Resolutions row answering the planted question.'), exitCode: 0, onCall: () => writeFileSync(wkAbsPath, appendedWkText(wkTextBefore, 'DEC-0901')) },
      { stream: JUDGE_STREAM_ANSWERS, exitCode: 0 },
      { stream: ESCALATION_STREAM_NOT_ESCALATED, exitCode: 0 },
    ]);

    const result = await runScenarioOnce(
      baseOpts({ suite, scenario: scenarioResult.data, scenarioDir, condition, runDir, testKb, kbRoot, launch }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Run dir layout.
    for (const f of ['stream.jsonl', 'stderr.log', 'run.json', 'diff.txt', 'wk-before.md', 'wk-after.md', 'metrics.json']) {
      expect(existsSync(join(runDir, f))).toBe(true);
    }
    expect(existsSync(join(runDir, 'judge-1'))).toBe(true);
    expect(existsSync(join(runDir, 'judge-1', 'prompt.txt'))).toBe(true);
    expect(existsSync(join(runDir, 'judge-1', 'stream.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'escalation-judge'))).toBe(true);
    expect(existsSync(join(runDir, 'escalation-judge', 'prompt.txt'))).toBe(true);
    expect(existsSync(join(runDir, 'escalation-judge', 'stream.jsonl'))).toBe(true);

    // Separate jail runs, fresh homes, MCP none, no allowed tools -- citation judge, then escalation judge.
    expect(calls.length).toBe(3);
    for (const call of [calls[1], calls[2]]) {
      const judgeCommand = call.command;
      expect(judgeCommand).toContain('--model');
      expect(judgeCommand[judgeCommand.indexOf('--model') + 1]).toBe('claude-sonnet-5');
      expect(judgeCommand[judgeCommand.indexOf('--max-budget-usd') + 1]).toBe('2');
      expect(judgeCommand[judgeCommand.indexOf('--allowedTools') + 1]).toBe('');
    }

    const judgeMcpConfig = JSON.parse(readFileSync(join(runDir, 'judge-1', 'home', 'mcp-config.json'), 'utf8'));
    expect(judgeMcpConfig).toEqual({ mcpServers: {} });
    const escalationJudgeMcpConfig = JSON.parse(readFileSync(join(runDir, 'escalation-judge', 'home', 'mcp-config.json'), 'utf8'));
    expect(escalationJudgeMcpConfig).toEqual({ mcpServers: {} });

    // The escalation prompt carries only the planted question and the reply text.
    const escalationPrompt = readFileSync(join(runDir, 'escalation-judge', 'prompt.txt'), 'utf8');
    expect(escalationPrompt).toContain('Should billing reach the ledger through an MCP server or a direct import?');
    expect(escalationPrompt).toContain('Added a Resolutions row answering the planted question.');

    // Outcome and pins.
    expect(result.data.validity).toEqual({ valid: true });
    expect(result.data.outcome.passed).toBe(true);
    expect(result.data.cited_rows).toBe(1);
    expect(result.data.escalation_verdict).toBe('not-escalated');
    expect(result.data.cli_version).toBe('2.1.281 (Claude Code)');
    expect(result.data.role_text_blob).toBe(git(['rev-parse', `${kbRootSha}:contract/roles/planner.md`], kbRoot).trim());
    expect(result.data.test_kb_baseline_sha).toBe(suite.baseline_sha);
    expect(result.data.agents_block).toEqual({ kb_commit: '1234567', words: 42 });
    expect(result.data.judge_model).toBe('claude-sonnet-5');
    expect(result.data.escalation_judge_prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // Acceptance 8a: the escalation verdict alone decides opposite-outcome and resolvable_escalated, even
  // when the reply carries no template line at all.
  it('fails opposite-outcome with resolvable_escalated 1 when the escalation judge says escalated, even with no template line', async () => {
    const { scenarioDir, testKb, kbRoot, wkAbsPath, wkTextBefore } = setUpScenario();
    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const baselineSha = gitCommitAll(testKb, 'baseline');
    const suite: Suite = {
      schema_version: 1,
      suite: 'fixture-suite',
      baseline_sha: baselineSha,
      agents_block: { kb_commit: '1234567', words: 42 },
      model: 'claude-opus-5-5',
      budget_usd: 2,
      timeout_sec: 60,
      mcp: 'none',
      repeats: 1,
      gated_condition: null,
      conditions: [],
    };
    const condition = { name: 'baseline', install_command: null, install_skills: [] };

    const runDir = join(workDir, 'run');
    const { launch, calls } = makeLaunch([
      {
        stream: MAIN_STREAM('A prose approval ask with no template line at all.'),
        exitCode: 0,
        onCall: () => writeFileSync(wkAbsPath, appendedWkText(wkTextBefore, 'DEC-0901')),
      },
      { stream: JUDGE_STREAM_ANSWERS, exitCode: 0 },
      { stream: ESCALATION_STREAM_ESCALATED, exitCode: 0 },
    ]);

    const result = await runScenarioOnce(
      baseOpts({ suite, scenario: scenarioResult.data, scenarioDir, condition, runDir, testKb, kbRoot, launch }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBe(3);
    expect(result.data.outcome).toEqual({ passed: false, reason: 'opposite-outcome' });
    expect(result.data.resolvable_escalated).toBe(1);
    expect(result.data.escalation_verdict).toBe('escalated');
  });

  // Acceptance 8c: two invalid escalation judge replies (the main call plus the one retry) give
  // escalation-judge-invalid and escalation_verdict 'invalid'.
  it('fails escalation-judge-invalid with escalation_verdict "invalid" after two invalid escalation judge replies', async () => {
    const { scenarioDir, testKb, kbRoot, wkAbsPath, wkTextBefore } = setUpScenario();
    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const baselineSha = gitCommitAll(testKb, 'baseline');
    const suite: Suite = {
      schema_version: 1,
      suite: 'fixture-suite',
      baseline_sha: baselineSha,
      agents_block: { kb_commit: '1234567', words: 42 },
      model: 'claude-opus-5-5',
      budget_usd: 2,
      timeout_sec: 60,
      mcp: 'none',
      repeats: 1,
      gated_condition: null,
      conditions: [],
    };
    const condition = { name: 'baseline', install_command: null, install_skills: [] };

    const runDir = join(workDir, 'run');
    const { launch, calls } = makeLaunch([
      {
        stream: MAIN_STREAM('Added a Resolutions row answering the planted question.'),
        exitCode: 0,
        onCall: () => writeFileSync(wkAbsPath, appendedWkText(wkTextBefore, 'DEC-0901')),
      },
      { stream: JUDGE_STREAM_ANSWERS, exitCode: 0 },
      { stream: ESCALATION_STREAM_INVALID, exitCode: 0 },
      { stream: ESCALATION_STREAM_INVALID, exitCode: 0 },
    ]);

    const result = await runScenarioOnce(
      baseOpts({ suite, scenario: scenarioResult.data, scenarioDir, condition, runDir, testKb, kbRoot, launch }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBe(4);
    expect(result.data.outcome).toEqual({ passed: false, reason: 'escalation-judge-invalid' });
    expect(result.data.escalation_verdict).toBe('invalid');
    expect(result.data.resolvable_escalated).toBe(0);
  });

  it('never sends a row with a dangling citation to the judge', async () => {
    const { scenarioDir, testKb, kbRoot, wkAbsPath, wkTextBefore } = setUpScenario();
    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const baselineSha = gitCommitAll(testKb, 'baseline');

    const suite: Suite = {
      schema_version: 1,
      suite: 'fixture-suite',
      baseline_sha: baselineSha,
      agents_block: { kb_commit: '1234567', words: 42 },
      model: 'claude-opus-5-5',
      budget_usd: 2,
      timeout_sec: 60,
      mcp: 'none',
      repeats: 1,
      gated_condition: null,
      conditions: [],
    };
    const condition = { name: 'baseline', install_command: null, install_skills: [] };

    const runDir = join(workDir, 'run');
    const { launch, calls } = makeLaunch([
      {
        stream: MAIN_STREAM('Added a Resolutions row citing a record that does not exist.'),
        exitCode: 0,
        onCall: () => writeFileSync(wkAbsPath, appendedWkText(wkTextBefore, 'DEC-9999')),
      },
      { stream: ESCALATION_STREAM_NOT_ESCALATED, exitCode: 0 },
    ]);

    const result = await runScenarioOnce(
      baseOpts({ suite, scenario: scenarioResult.data, scenarioDir, condition, runDir, testKb, kbRoot, launch }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No eligible row means no citation judge call, but the escalation judge still runs (resolvable class).
    expect(calls.length).toBe(2);
    expect(existsSync(join(runDir, 'judge-1'))).toBe(false);
    expect(existsSync(join(runDir, 'escalation-judge'))).toBe(true);
    expect(result.data.cited_rows).toBe(0);
    expect(result.data.outcome).toEqual({ passed: false, reason: 'row-precheck' });
  });

  // Acceptance: operator-only runs launch no escalation judge and keep the literal first-line test.
  it('launches no escalation judge for an operator-only scenario, even with a prose escalation ask', async () => {
    const testKb = join(workDir, 'test_kb');
    gitInit(testKb);
    mkdirSync(join(testKb, 'wiki', 'issues'), { recursive: true });
    writeFileSync(join(testKb, 'wiki', 'issues', '.gitkeep'), '');

    const scenarioDir = join(workDir, 'scenario-operator-only');
    mkdirSync(join(scenarioDir, 'records', 'issues'), { recursive: true });
    const wkTextBefore = [
      '---',
      'id: "WK-9102"',
      'title: "Operator-only fixture WK"',
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
      '# WK-9102: Operator-only fixture WK',
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
    writeFileSync(join(scenarioDir, 'records', 'issues', 'WK-9102.md'), wkTextBefore);
    writeFileSync(
      join(scenarioDir, 'scenario.json'),
      JSON.stringify(
        {
          schema_version: 1,
          id: 'fixture-operator-only',
          prompt: '/planner-eval WK-9102',
          target_wk: 'WK-9102',
          seeded_in: null,
          planted_question: 'Should we push the internal wiki repository to the public GitHub remote now?',
          class: 'operator-only',
          permitted_outcome: 'The reply escalates to the operator.',
          checks: ['read-wk'],
          pass_threshold: { passes: 3, of: 3 },
        },
        null,
        2,
      ),
    );

    const scenarioResult = loadScenario(scenarioDir);
    expect(scenarioResult.ok).toBe(true);
    if (!scenarioResult.ok) return;

    const baselineSha = gitCommitAll(testKb, 'baseline');
    const suite: Suite = {
      schema_version: 1,
      suite: 'fixture-suite',
      baseline_sha: baselineSha,
      agents_block: { kb_commit: '1234567', words: 42 },
      model: 'claude-opus-5-5',
      budget_usd: 2,
      timeout_sec: 60,
      mcp: 'none',
      repeats: 1,
      gated_condition: null,
      conditions: [],
    };
    const condition = { name: 'baseline', install_command: null, install_skills: [] };

    const runDir = join(workDir, 'run');
    // A prose escalation ask, not the literal template line -- operator-only still requires the literal
    // first line, so this must fail opposite-outcome, and no escalation judge must ever be launched.
    const { launch, calls } = makeLaunch([
      { stream: MAIN_STREAM('Approve the Resolutions edit before I write it?'), exitCode: 0 },
    ]);

    const result = await runScenarioOnce(
      baseOpts({ suite, scenario: scenarioResult.data, scenarioDir, condition, runDir, testKb, kbRoot: join(workDir, 'kb-root-unused'), launch }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.length).toBe(1);
    expect(existsSync(join(runDir, 'escalation-judge'))).toBe(false);
    expect(result.data.escalation_verdict).toBe('n/a');
    expect(result.data.outcome).toEqual({ passed: false, reason: 'opposite-outcome' });
  });
});
