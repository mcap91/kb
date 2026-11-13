/**
 * WK-0266 s2 — forwarder usage tap + `provider-usage.jsonl` + cost_usd/
 * inference_provider derived from it (rulings 1, 3, 6, 7, 8).
 *
 * This file covers the PURE, file-free logic: `summarizeProviderUsage`
 * (coverage math + inference_provider derivation, ruling 3/6) and
 * `readProviderUsageFile` (parsing the file, resolution 16's cut-line
 * handling, resolution 17's forwarder-timeout handling) — both exported at
 * module scope from `pipeline.ts` for direct testing (mirrors that file's
 * existing `buildPiBaseUrl`/`mergeProvenanceFrontmatter` pattern). It also
 * covers capture.ts's `provider_cost_coverage` Token Detail row rendering
 * (ruling 7) via `writeResponseDoc` directly.
 *
 * The REAL generated forwarder (tunnel.ts) — the tap's byte-level SSE
 * parsing, transparency (AC5), and the real-process AC3/AC6 cases — is
 * covered by `tests/dispatch-v2-tunnel.test.ts` (script-text assertions) and
 * `tests/dispatch-v2-tunnel-integration.test.ts` (real process, real HTTP).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readProviderUsageFile,
  summarizeProviderUsage,
  waitForChildExit,
  FORWARDER_EXIT_TIMEOUT_MS,
  type ProviderUsageRecord,
} from '../packages/dispatch-core/src/pipeline.js';
import { writeResponseDoc, type ProviderCostCoverage, type WorkerUsageDetail } from '../packages/dispatch-core/src/capture.js';
import type { DeliveryOutcome } from '../packages/dispatch-core/src/delivery.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function record(overrides: Partial<ProviderUsageRecord> = {}): ProviderUsageRecord {
  return {
    status: 200,
    content_type: 'text/event-stream',
    generation_id: 'gen-1',
    providers: [],
    header_provider: null,
    cost: null,
    cost_details: null,
    ended: true,
    dropped_lines: 0,
    parse_errors: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FORWARDER_EXIT_TIMEOUT_MS — the named, bounded constant (ruling 3 /
// Resolutions row 17; Expected Output: "naming the forwarder-exit timeout
// constant").
// ---------------------------------------------------------------------------

describe('FORWARDER_EXIT_TIMEOUT_MS', () => {
  it('is a positive, bounded timeout (not Infinity, not 0)', () => {
    expect(FORWARDER_EXIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FORWARDER_EXIT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
// waitForChildExit — the bounded wait pipeline.ts applies before reading
// provider-usage.jsonl (ruling 3 / Resolutions row 17)
// ---------------------------------------------------------------------------

describe('waitForChildExit', () => {
  it('resolves true once the child actually exits, well within a generous timeout', async () => {
    const child = spawn('node', ['-e', 'setTimeout(() => process.exit(0), 50)']);
    const exited = await waitForChildExit(child, 5_000);
    expect(exited).toBe(true);
  });

  it('resolves false if the timeout elapses before the child exits (and does not throw/hang)', async () => {
    const child = spawn('node', ['-e', 'setTimeout(() => process.exit(0), 2_000)']);
    const exited = await waitForChildExit(child, 100);
    expect(exited).toBe(false);
    child.kill(); // cleanup — don't leak the still-running probe process
  });

  it('resolves true immediately for a child that already exited before the call', async () => {
    const child = spawn('node', ['-e', 'process.exit(0)']);
    await new Promise((resolve) => child.once('exit', resolve));
    const exited = await waitForChildExit(child, 5_000);
    expect(exited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summarizeProviderUsage — cost_usd/coverage math (ruling 3)
// ---------------------------------------------------------------------------

describe('summarizeProviderUsage — cost_usd all-or-nothing rule (WK-0266 ruling 3, AC1/AC6)', () => {
  it('full coverage: cost_usd is the sum over all 2xx records (AC1)', () => {
    const records = [
      record({ cost: 0.00000928, providers: ['Morph'] }),
      record({ cost: 0.0000034, providers: ['Morph'] }),
    ];
    const summary = summarizeProviderUsage(records);
    expect(summary.coverage.n).toBe(2);
    expect(summary.coverage.k).toBe(2);
    expect(summary.coverage.costUsd).toBeCloseTo(0.00001268, 10);
    expect(summary.coverage.billedPartialSum).toBeCloseTo(0.00001268, 10);
  });

  it('partial coverage (one null cost, e.g. a client disconnect): cost_usd is 0, billedPartialSum keeps the known dollars visible (AC6 case 1)', () => {
    const records = [
      record({ cost: 0.5, providers: ['Morph'] }),
      record({ cost: null, ended: false, providers: [] }), // disconnected mid-stream
    ];
    const summary = summarizeProviderUsage(records);
    expect(summary.coverage.n).toBe(2);
    expect(summary.coverage.k).toBe(1);
    expect(summary.coverage.costUsd).toBe(0); // never a partial sum (ruling 3: all-or-nothing)
    expect(summary.coverage.billedPartialSum).toBe(0.5);
  });

  it('zero 2xx records: n=0, k=0, cost_usd=0 (falls back to the rate table upstream)', () => {
    const summary = summarizeProviderUsage([]);
    expect(summary.coverage).toEqual({ n: 0, k: 0, costUsd: 0, billedPartialSum: 0 });
  });

  it('non-2xx records (429/5xx) are kept for forensics but excluded from n/k (ruling 3)', () => {
    const records = [
      record({ status: 429, cost: null, ended: true }),
      record({ status: 200, cost: 0.1, providers: ['Morph'] }),
    ];
    const summary = summarizeProviderUsage(records);
    expect(summary.coverage.n).toBe(1);
    expect(summary.coverage.k).toBe(1);
    expect(summary.coverage.costUsd).toBe(0.1);
  });

  it("Pi retries/compaction calls through the same endpoint are counted and summed (multiple 2xx records, all with cost)", () => {
    const records = [record({ cost: 0.01 }), record({ cost: 0.02 }), record({ cost: 0.03 })];
    const summary = summarizeProviderUsage(records);
    expect(summary.coverage.n).toBe(3);
    expect(summary.coverage.k).toBe(3);
    expect(summary.coverage.costUsd).toBeCloseTo(0.06, 10);
  });
});

describe('summarizeProviderUsage — inference_provider derivation (WK-0266 ruling 6, AC3)', () => {
  it('distinct body providers across 2xx records, first-seen order, joined with ", "', () => {
    const records = [
      record({ providers: ['Morph'] }),
      record({ providers: ['Morph'] }), // dup, no change
      record({ providers: ['Together'] }),
    ];
    expect(summarizeProviderUsage(records).inferenceProvider).toBe('Morph, Together');
  });

  it('a record with no body provider falls back to its own x-inference-provider header (HuggingFace path)', () => {
    const records = [record({ providers: [], header_provider: 'hf-inference' })];
    expect(summarizeProviderUsage(records).inferenceProvider).toBe('hf-inference');
  });

  it('a record with a body provider ignores its own header (body wins per-record)', () => {
    const records = [record({ providers: ['Morph'], header_provider: 'hf-inference' })];
    expect(summarizeProviderUsage(records).inferenceProvider).toBe('Morph');
  });

  it('no 2xx record carries a body or header provider at all -> unknown', () => {
    const records = [record({ providers: [], header_provider: null })];
    expect(summarizeProviderUsage(records).inferenceProvider).toBe('unknown');
  });

  it('zero records -> unknown', () => {
    expect(summarizeProviderUsage([]).inferenceProvider).toBe('unknown');
  });

  it('non-2xx records never contribute a provider', () => {
    const records = [record({ status: 500, providers: ['ShouldNotCount'] })];
    expect(summarizeProviderUsage(records).inferenceProvider).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// readProviderUsageFile — parsing provider-usage.jsonl (ruling 8, resolutions 16/17)
// ---------------------------------------------------------------------------

describe('readProviderUsageFile', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a missing file (no request was ever relayed) degrades to zero records, never throws', async () => {
    dir = await createTempDir('kb-provider-usage-missing-');
    const records = await readProviderUsageFile(join(dir, 'provider-usage.jsonl'), false, false);
    expect(records).toEqual([]);
  });

  it('parses one JSON object per line', async () => {
    dir = await createTempDir('kb-provider-usage-parse-');
    const path = join(dir, 'provider-usage.jsonl');
    await writeFile(
      path,
      [JSON.stringify(record({ generation_id: 'a' })), JSON.stringify(record({ generation_id: 'b' }))].join('\n') + '\n',
      'utf8',
    );
    const records = await readProviderUsageFile(path, false, false);
    expect(records).toHaveLength(2);
    expect(records[0].generation_id).toBe('a');
    expect(records[1].generation_id).toBe('b');
  });

  it(
    'a final line cut mid-write (SIGKILL) counts as one uncovered 2xx record (cost:null, ended:false) and never throws (resolution 16, AC6 case 3)',
    async () => {
      dir = await createTempDir('kb-provider-usage-cut-');
      const path = join(dir, 'provider-usage.jsonl');
      const goodLine = JSON.stringify(record({ generation_id: 'good', cost: 0.1 }));
      const cutLine = '{"status":200,"content_type":"text/event-str'; // truncated mid-write
      await writeFile(path, `${goodLine}\n${cutLine}`, 'utf8');

      const records = await readProviderUsageFile(path, false, false);
      expect(records).toHaveLength(2);
      expect(records[0].generation_id).toBe('good');
      // The cut line becomes an uncovered 2xx record, never thrown.
      expect(records[1].status).toBe(200);
      expect(records[1].cost).toBeNull();
      expect(records[1].ended).toBe(false);

      const summary = summarizeProviderUsage(records);
      expect(summary.coverage.n).toBe(2);
      expect(summary.coverage.k).toBe(1); // the cut line never counts as covered
      expect(summary.coverage.costUsd).toBe(0);
    },
  );

  it('logs the 1-based line number of a line that failed to parse when verbose (never swallowed silently)', async () => {
    dir = await createTempDir('kb-provider-usage-log-');
    const path = join(dir, 'provider-usage.jsonl');
    await writeFile(path, `${JSON.stringify(record())}\nnot json at all\n`, 'utf8');

    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await readProviderUsageFile(path, false, true);
    } finally {
      process.stderr.write = original;
    }
    expect(writes.some((line) => line.includes('line 2') && line.includes('provider-usage.jsonl'))).toBe(true);
  });

  it(
    'a forwarder-exit timeout (the bounded wait expired) appends one further uncovered 2xx record, even on an otherwise-clean file (resolution 17)',
    async () => {
      dir = await createTempDir('kb-provider-usage-timeout-');
      const path = join(dir, 'provider-usage.jsonl');
      await writeFile(path, `${JSON.stringify(record({ cost: 0.2 }))}\n`, 'utf8');

      const withoutTimeout = await readProviderUsageFile(path, false, false);
      expect(summarizeProviderUsage(withoutTimeout).coverage).toEqual({ n: 1, k: 1, costUsd: 0.2, billedPartialSum: 0.2 });

      const withTimeout = await readProviderUsageFile(path, true, false);
      const summary = summarizeProviderUsage(withTimeout);
      expect(summary.coverage.n).toBe(2);
      expect(summary.coverage.k).toBe(1);
      expect(summary.coverage.costUsd).toBe(0); // the timeout turns full coverage into partial
    },
  );

  it('blank/whitespace-only trailing lines are ignored (not counted as an uncovered record)', async () => {
    dir = await createTempDir('kb-provider-usage-blank-');
    const path = join(dir, 'provider-usage.jsonl');
    await writeFile(path, `${JSON.stringify(record())}\n\n   \n`, 'utf8');
    const records = await readProviderUsageFile(path, false, false);
    expect(records).toHaveLength(1);
  });

  it('a record written via appendFileSync-style incremental appends (simulating the forwarder) parses the same as a single write', async () => {
    dir = await createTempDir('kb-provider-usage-append-');
    const path = join(dir, 'provider-usage.jsonl');
    await writeFile(path, '', 'utf8');
    await appendFile(path, JSON.stringify(record({ generation_id: 'r1' })) + '\n', 'utf8');
    await appendFile(path, JSON.stringify(record({ generation_id: 'r2' })) + '\n', 'utf8');
    const records = await readProviderUsageFile(path, false, false);
    expect(records.map((r) => r.generation_id)).toEqual(['r1', 'r2']);
  });
});

// ---------------------------------------------------------------------------
// capture.ts — provider_cost_coverage Token Detail row (WK-0266 ruling 7)
// ---------------------------------------------------------------------------

const NO_OP_DELIVERY: DeliveryOutcome = {
  status: 'delivered',
  branch: 'dispatch/HO-9999',
  commitSha: 'deadbeef',
  changedFiles: ['src/foo.ts'],
};

describe('capture.ts — provider_cost_coverage row (WK-0266 ruling 7)', () => {
  let runDir: string | undefined;
  afterEach(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  async function renderWithCoverage(usage: WorkerUsageDetail, coverage: ProviderCostCoverage | undefined): Promise<string> {
    runDir = await createTempDir('kb-provider-cost-coverage-');
    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-9999', title: 'coverage row', mode: 'implement' },
      delivery: NO_OP_DELIVERY,
      piResult: { outcome: 'completed', usage },
      model: 'openrouter-zdr-morph/deepseek/deepseek-v4.1-flash',
      modelId: 'deepseek/deepseek-v4.1-flash',
      billing: 'api',
      rateKeyPrefix: 'openrouter/',
      providerCostCoverage: coverage,
      isolationBackend: 'bwrap',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('writeResponseDoc failed');
    return result.data.responseContent;
  }

  it('full coverage (k === n): renders "k/n" with no billed-partial note, cost_usd equals the sum, est_cost_usd mirrors it (ruling 4, unchanged)', async () => {
    const usage: WorkerUsageDetail = {
      inputTokens: 37,
      outputTokens: 13,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 13,
      totalTokens: 50,
      costUsd: 0.00000928, // pipeline.ts overrides this to the forwarder sum before calling writeResponseDoc
    };
    const content = await renderWithCoverage(usage, { n: 1, k: 1, costUsd: 0.00000928, billedPartialSum: 0.00000928 });
    expect(content).toContain('| provider_cost_coverage | 1/1 |');
    expect(content).toContain('cost_usd: 0.00000928');
    expect(content).toContain('| cost_usd | $0.0000 |');
    expect(content).toContain('| est_cost_usd | $0.0000 |');
  });

  it('partial coverage (k < n): renders "k/n ($X billed)", cost_usd is 0, est_cost_usd rate-table-derived (AC6 case 1)', async () => {
    const usage: WorkerUsageDetail = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 2_000_000,
      costUsd: 0, // pipeline.ts's override: partial coverage never sums to cost_usd
    };
    const content = await renderWithCoverage(usage, { n: 2, k: 1, costUsd: 0, billedPartialSum: 1.2345 });
    expect(content).toContain('| provider_cost_coverage | 1/2 ($1.2345 billed) |');
    expect(content).toContain('cost_usd: 0');
    expect(content).toContain('| cost_usd | $0.0000 |');
    // deepseek/deepseek-v4.1-flash via openrouter/ prefix: rate-table estimate, not $0.0000.
    expect(content).not.toContain('| est_cost_usd | $0.0000 |');
  });

  it('no coverage data at all (codex/claude families — CONNECT-tunnelled, out of WK-0266 scope): the row is omitted entirely, not a misleading "0/0"', async () => {
    const usage: WorkerUsageDetail = {
      inputTokens: 6,
      outputTokens: 583,
      cacheReadTokens: 100374,
      cacheWriteTokens: 7638,
      reasoningTokens: null,
      totalTokens: 589,
      costUsd: 0.0847032,
    };
    const content = await renderWithCoverage(usage, undefined);
    expect(content).not.toContain('provider_cost_coverage');
  });

  it('n === 0 (pi family ran, but zero 2xx records were ever relayed): renders "0/0"', async () => {
    const usage: WorkerUsageDetail = {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 0,
      costUsd: 0,
    };
    const content = await renderWithCoverage(usage, { n: 0, k: 0, costUsd: 0, billedPartialSum: 0 });
    expect(content).toContain('| provider_cost_coverage | 0/0 |');
  });

  it('existing rows (rate_key, est_cost_usd, cost_usd) keep their exact names and formats alongside the new row (ruling 7)', async () => {
    const usage: WorkerUsageDetail = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 2_000_000,
      costUsd: 0,
    };
    const content = await renderWithCoverage(usage, { n: 1, k: 0, costUsd: 0, billedPartialSum: 0 });
    expect(content).toContain('| rate_key | openrouter/deepseek/deepseek-v4.1-flash |');
    expect(content).toContain('| est_cost_usd | $0.6662 |');
    // k < n (literal ruling 7: the billed-partial note shows whenever k < n, even k=0).
    expect(content).toContain('| provider_cost_coverage | 0/1 ($0.0000 billed) |');
  });
});
