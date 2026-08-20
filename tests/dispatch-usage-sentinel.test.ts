/**
 * Tests for the dispatch `.agent-runs` usage sentinel (WK-0066, situations 3 + 7).
 *
 * The round-trip the coverage contract requires:
 *   adapter prints `##KB_USAGE##` on stderr → launcher writes metadata/usage.json → value-usage's
 *   dispatch reader ingests + prices it.
 *
 * Three layers are proven here:
 *   1. parseLastUsageSentinel — the pure parser (last-sentinel, log-prefix tolerant).
 *   2. the ollama adapter actually EMITS the sentinel with BOTH input (prompt_eval_count — the
 *      WK-0066 fix) and output (eval_count) tokens, exercised against a stub Ollama server.
 *   3. writeUsageSentinel → usage.json → defaultReadDispatchUsage → computeValueUsage prices it,
 *      with NO ~/.claude present (offline, repo-local bundle read).
 *
 * Host-native synthetic fixtures only (WK-0043): temp dirs + a loopback stub server; no personal
 * paths, symmetric on Windows and Linux/WSL.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';

import { parseLastUsageSentinel, writeUsageSentinel } from '../packages/dispatch-core/src/launch.js';
import {
  defaultReadDispatchUsage,
  computeValueUsage,
  type UsageDeps,
} from '../packages/wiki-core/src/value-usage.js';
import type { PricingTable } from '../packages/wiki-core/src/pricing.js';

// vitest runs from the repo root; resolve the shipped adapter relative to it.
const OLLAMA_ADAPTER = path.resolve(process.cwd(), 'scripts', 'blackboard-agent-ollama.mjs');

const SYN_TABLE: PricingTable = {
  'gpt-5.5': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000008,
    litellm_provider: 'openai',
  },
};

// ---------------------------------------------------------------------------
// 1. Pure parser
// ---------------------------------------------------------------------------

describe('parseLastUsageSentinel — last sentinel wins, log-prefix tolerant', () => {
  it('extracts the sentinel JSON even when a log prefix precedes the marker', () => {
    const raw = [
      '[blackboard-agent-ollama] model=qwen3-coder:30b url=http://localhost:11434',
      '##KB_USAGE## {"model":"qwen3-coder:30b","endpoint":"http://localhost:11434","prompt_tokens":200,"completion_tokens":100}',
      '[blackboard-agent-ollama] done in 1200 ms',
    ].join('\n');
    expect(parseLastUsageSentinel(raw)).toEqual({
      model: 'qwen3-coder:30b',
      endpoint: 'http://localhost:11434',
      prompt_tokens: 200,
      completion_tokens: 100,
    });
  });

  it('keeps the LAST sentinel when several are present (a retried call)', () => {
    const raw = [
      '##KB_USAGE## {"model":"a","endpoint":"e","prompt_tokens":1,"completion_tokens":1}',
      '##KB_USAGE## {"model":"b","endpoint":"e","prompt_tokens":9,"completion_tokens":9}',
    ].join('\n');
    expect(parseLastUsageSentinel(raw)).toMatchObject({ model: 'b', prompt_tokens: 9 });
  });

  it('returns null when there is no sentinel (claude/codex agents, or a failed adapter)', () => {
    expect(parseLastUsageSentinel('[some-agent] did work\nno sentinel here\n')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The ollama adapter emits the sentinel with input + output tokens
// ---------------------------------------------------------------------------

describe('blackboard-agent-ollama.mjs — emits ##KB_USAGE## with input (prompt_eval_count) + output', () => {
  let server: http.Server | undefined;
  let handoffDir: string | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (handoffDir) fs.rmSync(handoffDir, { recursive: true, force: true });
    handoffDir = undefined;
  });

  it('captures BOTH prompt_eval_count (input) and eval_count (output) in the sentinel', async () => {
    // Stub Ollama: return a content + the two token counts the WK-0066 fix must read.
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { content: 'the answer' },
            prompt_eval_count: 200,
            eval_count: 100,
            eval_duration: 1_000_000_000,
          }),
        );
      });
    });
    const port: number = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as import('node:net').AddressInfo).port);
      });
    });

    handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ollama-adapter-'));
    const handoffPath = path.join(handoffDir, 'handoff.md');
    fs.writeFileSync(handoffPath, 'Do the task.', 'utf-8');

    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [OLLAMA_ADAPTER], {
        env: {
          ...process.env,
          OLLAMA_URL: `http://127.0.0.1:${port}`,
          OLLAMA_MODEL: 'qwen3-coder:30b',
          AGENT_BLACKBOARD_HANDOFF_PATH: handoffPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', () => resolve(err));
    });

    const sentinel = parseLastUsageSentinel(stderr);
    expect(sentinel).not.toBeNull();
    expect(sentinel).toMatchObject({
      model: 'qwen3-coder:30b',
      prompt_tokens: 200, // input tokens — the bug WK-0066 fixed (was never captured)
      completion_tokens: 100, // output tokens
    });
    expect(String(sentinel!.endpoint)).toContain(`127.0.0.1:${port}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Full round-trip: launcher writes usage.json → reader ingests → prices (offline)
// ---------------------------------------------------------------------------

describe('sentinel round-trip — launcher usage.json → dispatch reader → priced (no ~/.claude)', () => {
  let repo: string | undefined;

  afterEach(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  it('writeUsageSentinel writes metadata/usage.json that the reader ingests and prices', async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sentinel-roundtrip-'));
    const metaDir = path.join(repo, '.agent-runs', 'runs', 'H1', 'RUN-a', 'metadata');
    fs.mkdirSync(metaDir, { recursive: true });

    // What the launcher captured on the adapter's stderr (an OpenRouter/remote run).
    const stderrPath = path.join(metaDir, 'stderr.log');
    fs.writeFileSync(
      stderrPath,
      [
        '[blackboard-agent-openrouter] model=gpt-5.5 base=https://openrouter.ai/api/v1',
        '##KB_USAGE## {"model":"gpt-5.5","endpoint":"https://openrouter.ai/api/v1","prompt_tokens":1000,"completion_tokens":500}',
      ].join('\n'),
      'utf-8',
    );
    // The launcher-owned bundle timestamp used for windowing.
    fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify({ completed_at: '2026-07-05T10:00:00Z' }), 'utf-8');

    // Launcher step: parse the sentinel → metadata/usage.json.
    await writeUsageSentinel(metaDir, stderrPath);
    const usageJson = JSON.parse(fs.readFileSync(path.join(metaDir, 'usage.json'), 'utf-8'));
    expect(usageJson).toEqual({
      model: 'gpt-5.5',
      endpoint: 'https://openrouter.ai/api/v1',
      prompt_tokens: 1000,
      completion_tokens: 500,
    });

    // Reader step: the dispatch reader ingests the launcher-written file (repo-local, offline).
    const recs = defaultReadDispatchUsage({ since: '2026-07-01', until: '2026-07-10', roots: [repo] });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ source: 'dispatch', model: 'gpt-5.5', input_tokens: 1000, output_tokens: 500, local: false });

    // Pricing step: computeValueUsage prices it via the (synthetic) table — no ~/.claude needed.
    const deps: UsageDeps = {
      readClaudeSessions: () => [],
      readCodexSessions: () => [],
      readDispatchUsage: defaultReadDispatchUsage,
      loadPricingTable: () => SYN_TABLE,
      listWorktreeRoots: () => [],
    };
    const result = await computeValueUsage({ dir: repo, since: '2026-07-01', until: '2026-07-10' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.agents).toEqual(['dispatch']);
    // 1000*1e-6 + 500*8e-6 = 0.001 + 0.004 = 0.005
    expect(result.data.est_usd).toBeCloseTo(0.005, 12);
    expect(result.data.by_model[0]!.provider).toBe('openai');
  });
});
