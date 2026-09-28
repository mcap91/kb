/**
 * WK-0123 — granular per-field token capture + on-the-fly cost estimation.
 *
 * NOTE ON DISCOVERY (flagged, not silently worked around): this file lives at
 * the write_scope path granted to this handoff (`packages/dispatch-core/
 * tests/`), but the repo's ONLY vitest config (`vitest.config.ts` at the repo
 * root) declares `include: ["tests/**\/*.test.ts"]` — the root-level `tests/`
 * directory, where every other dispatch-core test actually lives (e.g.
 * `tests/dispatch-v2-adapters.test.ts`). Verified empirically
 * (`npx vitest list`): a file placed under `packages/dispatch-core/tests/`
 * is never discovered by `npm test`. Neither `vitest.config.ts` nor the root
 * `tests/` directory is in this handoff's write_scope, so this file cannot be
 * moved to where it would actually run without an out-of-scope change. See
 * the final handoff response for the explicit stop/decision-needed note.
 *
 * Golden fixtures used (DEC-0009, real unedited captures, `tests/fixtures/`
 * relative to the repo root):
 *  - `codex-exec-output-stream-json.jsonl` — real `codex exec --json` capture;
 *    carries the full `turn.completed` usage object this WK needs
 *    (input/cached-input/output/reasoning).
 *  - `claude-p-output.txt` — real `claude -p --output-format json` capture;
 *    carries the full usage object (input/cache-creation/cache-read/output)
 *    plus a real `total_cost_usd`. NOT `claude-p-output-stream-json.jsonl` —
 *    that fixture is `--output-format stream-json` (multiple JSON-lines
 *    events for a different consumer, `dispatch-worker-events.test.ts`'s
 *    `parseWorkerEvents`), and fails `parseClaudeOutput` (which expects
 *    stdout to be exactly one JSON object) with `ADAPTER_FAILED` — verified
 *    directly against this repo's `parseClaudeOutput`. `claude-p-output.txt`
 *    is the real, already-golden fixture that actually carries the usage
 *    frame this WK's acceptance criterion asks for.
 *  - Pi: no captured stream-json fixture exists for `parsePiOutput` with a
 *    hand-derived edge case, so the two Pi fixtures below are hand-derived
 *    JSONL, mirroring the exact real event shape captured in
 *    `tests/fixtures/pi-output-code-review.jsonl` (`message_end` /
 *    `message.usage.{input,output,cacheRead,cacheWrite,reasoning,
 *    totalTokens,cost.total}` / `agent_end`) — verified against that real
 *    fixture's structure before authoring these by hand (DEC-0009: no
 *    invented field names).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCodexOutput } from '../src/adapters/codex.js';
import { parseClaudeOutput } from '../src/adapters/claude.js';
import { parsePiOutput } from '../src/adapters/pi.js';
import { writeResponseDoc, computeEstCostUsd, loadTokenRates, type WorkerUsageDetail } from '../src/capture.js';
import { loadBackendsTable } from '../src/repo-config.js';
import type { DeliveryOutcome } from '../src/delivery.js';

// Repo root is 3 levels up from packages/dispatch-core/tests/.
const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures');

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const NO_OP_DELIVERY: DeliveryOutcome = {
  status: 'delivered',
  branch: 'dispatch/HO-9999',
  commitSha: 'deadbeef',
  changedFiles: ['src/foo.ts'],
};

// ---------------------------------------------------------------------------
// contract/token-rates.json — loadTokenRates
// ---------------------------------------------------------------------------

describe('capture.ts — loadTokenRates (WK-0123)', () => {
  it('loads the vendored contract/token-rates.json, skipping metadata keys', () => {
    const table = loadTokenRates();
    expect(table['claude-sonnet-5']).toEqual({
      input_per_1m: 2.0,
      output_per_1m: 10.0,
      cache_read_per_1m: 0.2,
      cache_write_per_1m: 2.5,
    });
    expect(table['gpt-5.6-terra']).toBeDefined();
    expect(table['deepseek-v4-flash']).toBeDefined();
    // Metadata keys (_source/_captured/_notes) must not surface as model rows.
    expect(table['_source']).toBeUndefined();
    expect(table['_captured']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Codex family — per-field capture from the real golden fixture
// ---------------------------------------------------------------------------

describe('WK-0123 — Codex family per-field token capture', () => {
  it('parseCodexOutput reports the full usage frame from the golden fixture', () => {
    const stdout = readFileSync(join(FIXTURES_DIR, 'codex-exec-output-stream-json.jsonl'), 'utf8');
    const result = parseCodexOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verbatim from the real capture (also asserted, less exhaustively, by
    // dispatch-v2-adapters.test.ts).
    expect(result.data.usage.inputTokens).toBe(92367);
    expect(result.data.usage.cachedInputTokens).toBe(83584);
    expect(result.data.usage.outputTokens).toBe(1659);
    expect(result.data.usage.reasoningOutputTokens).toBe(558);
  });

  let runDir: string | undefined;
  afterEach(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  it('writeResponseDoc renders every Codex field in ## Token Detail, with cache_write_tokens as unreported (—) and est_cost_usd rate-table-derived (Codex never reports cost)', async () => {
    const stdout = readFileSync(join(FIXTURES_DIR, 'codex-exec-output-stream-json.jsonl'), 'utf8');
    const parsed = parseCodexOutput(stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Mirrors pipeline.ts's Codex normalization branch exactly (no
    // cache-write field for Codex; costUsd always 0 — adapters/codex.ts
    // reports no cost figure).
    const usage: WorkerUsageDetail = {
      inputTokens: parsed.data.usage.inputTokens,
      outputTokens: parsed.data.usage.outputTokens,
      cacheReadTokens: parsed.data.usage.cachedInputTokens,
      cacheWriteTokens: null,
      reasoningTokens: parsed.data.usage.reasoningOutputTokens,
      totalTokens: parsed.data.usage.inputTokens + parsed.data.usage.outputTokens,
      costUsd: 0,
    };

    runDir = await createTempDir('kb-token-detail-codex-');
    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-9999', title: 'Codex token detail', mode: 'implement' },
      delivery: NO_OP_DELIVERY,
      piResult: { outcome: 'completed', usage },
      model: 'codex-saas/gpt-5.6-terra',
      modelId: 'gpt-5.6-terra',
      billing: 'api',
      isolationBackend: 'bwrap',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { responseContent } = result.data;
    // Frontmatter keeps the rolled-up pair unchanged (backward compat).
    expect(responseContent).toContain(`total_tokens: ${92367 + 1659}`);
    expect(responseContent).toContain('cost_usd: 0');

    expect(responseContent).toContain('## Token Detail');
    expect(responseContent).toContain('| input_tokens | 92,367 |');
    expect(responseContent).toContain('| output_tokens | 1,659 |');
    expect(responseContent).toContain('| cache_read_tokens | 83,584 |');
    expect(responseContent).toContain('| cache_write_tokens | — |');
    expect(responseContent).toContain('| reasoning_tokens | 558 |');
    expect(responseContent).toContain(`| total_tokens | ${(92367 + 1659).toLocaleString('en-US')} |`);
    expect(responseContent).toContain('| cost_usd | $0.0000 |');
    // Rate-table-derived (gpt-5.6-terra: input 2.00, output 12.00, cache_read 0.20 per 1M).
    expect(responseContent).toContain('| est_cost_usd | $0.2214 |');
  });
});

// ---------------------------------------------------------------------------
// Claude family — per-field capture from the real golden fixture
// ---------------------------------------------------------------------------

describe('WK-0123 — Claude family per-field token capture', () => {
  it('parseClaudeOutput reports the full usage frame from the golden fixture', () => {
    const stdout = readFileSync(join(FIXTURES_DIR, 'claude-p-output.txt'), 'utf8');
    const result = parseClaudeOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.usage.inputTokens).toBe(6);
    expect(result.data.usage.cacheCreationInputTokens).toBe(7638);
    expect(result.data.usage.cacheReadInputTokens).toBe(100374);
    expect(result.data.usage.outputTokens).toBe(583);
    expect(result.data.usage.costUsd).toBeCloseTo(0.0847032, 6);
  });

  let runDir: string | undefined;
  afterEach(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  it('writeResponseDoc renders every Claude field, and est_cost_usd = provider cost_usd (real cost is authoritative)', async () => {
    const stdout = readFileSync(join(FIXTURES_DIR, 'claude-p-output.txt'), 'utf8');
    const parsed = parseClaudeOutput(stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Mirrors pipeline.ts's Claude normalization branch exactly.
    const usage: WorkerUsageDetail = {
      inputTokens: parsed.data.usage.inputTokens,
      outputTokens: parsed.data.usage.outputTokens,
      cacheReadTokens: parsed.data.usage.cacheReadInputTokens,
      cacheWriteTokens: parsed.data.usage.cacheCreationInputTokens,
      reasoningTokens: null,
      totalTokens: parsed.data.usage.inputTokens + parsed.data.usage.outputTokens,
      costUsd: parsed.data.usage.costUsd,
    };

    runDir = await createTempDir('kb-token-detail-claude-');
    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-9999', title: 'Claude token detail', mode: 'implement' },
      delivery: NO_OP_DELIVERY,
      piResult: { outcome: 'completed', usage },
      model: 'claude-saas/claude-sonnet-5',
      modelId: 'claude-sonnet-5',
      billing: 'api',
      isolationBackend: 'bwrap',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { responseContent } = result.data;
    expect(responseContent).toContain(`total_tokens: ${6 + 583}`);

    expect(responseContent).toContain('## Token Detail');
    expect(responseContent).toContain('| input_tokens | 6 |');
    expect(responseContent).toContain('| output_tokens | 583 |');
    expect(responseContent).toContain('| cache_read_tokens | 100,374 |');
    expect(responseContent).toContain('| cache_write_tokens | 7,638 |');
    expect(responseContent).toContain('| reasoning_tokens | — |');
    expect(responseContent).toContain('| cost_usd | $0.0847 |');
    // Provider reported a real cost -> est_cost_usd mirrors it exactly, not a rate-table recompute.
    expect(responseContent).toContain('| est_cost_usd | $0.0847 |');
  });

  it('billing: "seat" overrides a real provider cost_usd with the rate-table estimate (subscription seats have no true per-token cost)', () => {
    const usage: WorkerUsageDetail = {
      inputTokens: 6,
      outputTokens: 583,
      cacheReadTokens: 100374,
      cacheWriteTokens: 7638,
      reasoningTokens: null,
      totalTokens: 589,
      costUsd: 0.0847032, // provider-reported, but must be ignored for a seat backend
    };
    const seatEstimate = computeEstCostUsd(usage, 'claude-sonnet-5', 'seat');
    expect(seatEstimate).toBe('$0.0450');
    expect(seatEstimate).not.toBe(`$${usage.costUsd.toFixed(4)}`);

    const apiEstimate = computeEstCostUsd(usage, 'claude-sonnet-5', 'api');
    expect(apiEstimate).toBe('$0.0847');
  });
});

// ---------------------------------------------------------------------------
// Pi family — hand-derived fixtures (real split present, and genuinely absent)
// ---------------------------------------------------------------------------

describe('WK-0123 — Pi family: DEC-0009 capture-first ruling', () => {
  it('parses the real per-field split when the stream carries it (real Pi/OpenRouter captures do — see tests/fixtures/pi-output-code-review.jsonl)', () => {
    const splitStream = [
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 200,
            cacheWrite: 0,
            reasoning: 50,
            totalTokens: 1550,
            cost: { input: 0.002, output: 0.006, cacheRead: 0.00004, cacheWrite: 0, total: 0.01 },
          },
        },
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const result = parsePiOutput(splitStream);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.usage.totalTokens).toBe(1550);
    expect(result.data.usage.costUsd).toBeCloseTo(0.01, 6);
    expect(result.data.usage.inputTokens).toBe(1000);
    expect(result.data.usage.outputTokens).toBe(500);
    expect(result.data.usage.cacheReadTokens).toBe(200);
    expect(result.data.usage.cacheWriteTokens).toBe(0);
    expect(result.data.usage.reasoningTokens).toBe(50);

    // Real reported cost -> est_cost_usd is the provider's own point figure,
    // never a blended/invented one — Pi "joins the real-numbers path".
    const estimate = computeEstCostUsd(result.data.usage, 'deepseek-v4-flash', 'api');
    expect(estimate).toBe('$0.0100');
  });

  it('falls back to a bounded floor–ceiling range when the split is genuinely absent (never a single blended number)', () => {
    const totalOnlyStream = [
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: { totalTokens: 1000, cost: { total: 0 } },
        },
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const result = parsePiOutput(totalOnlyStream);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.usage.totalTokens).toBe(1000);
    expect(result.data.usage.costUsd).toBe(0);
    expect(result.data.usage.inputTokens).toBeNull();
    expect(result.data.usage.outputTokens).toBeNull();
    expect(result.data.usage.cacheReadTokens).toBeNull();
    expect(result.data.usage.cacheWriteTokens).toBeNull();
    expect(result.data.usage.reasoningTokens).toBeNull();

    // deepseek-v4-flash: input 0.30, output 1.20 per 1M -> floor/ceiling bounds.
    const estimate = computeEstCostUsd(result.data.usage, 'deepseek-v4-flash', 'api');
    expect(estimate).toBe('$0.0003–$0.0012');
  });

  it('reports "unavailable" rather than a fabricated rate when the model has no rate-table row', () => {
    const usage: WorkerUsageDetail = {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 1000,
      costUsd: 0,
    };
    expect(computeEstCostUsd(usage, 'some-unknown-model-id', 'api')).toBe('unavailable');
    expect(computeEstCostUsd(usage, undefined, 'api')).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// repo-config.ts — BackendEntry.billing (WK-0123)
// ---------------------------------------------------------------------------

describe('repo-config.ts — BackendEntry.billing (WK-0123)', () => {
  it('accepts "seat" and "api", defaults to undefined (api) when absent, and refuses an invalid value', async () => {
    const dir = await createTempDir('kb-billing-config-');
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(dir, 'wiki', '.dispatch'), { recursive: true });
      await writeFile(
        join(dir, 'wiki', '.dispatch', 'backends.json'),
        JSON.stringify({
          'seat-backend': { family: 'claude', base_url: null, api_key_env: null, secrets_file: null, billing: 'seat' },
          'api-backend': { family: 'claude', base_url: null, api_key_env: null, secrets_file: null, billing: 'api' },
          'unset-backend': { family: 'claude', base_url: null, api_key_env: null, secrets_file: null },
        }),
        'utf8',
      );

      const result = await loadBackendsTable(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data['seat-backend'].billing).toBe('seat');
      expect(result.data['api-backend'].billing).toBe('api');
      // Absent = defaults to 'api' at the consumption site (pipeline.ts); the
      // loader itself leaves it undefined rather than inventing a value.
      expect(result.data['unset-backend'].billing).toBeUndefined();

      await writeFile(
        join(dir, 'wiki', '.dispatch', 'backends.json'),
        JSON.stringify({
          'bad-backend': { family: 'claude', base_url: null, api_key_env: null, secrets_file: null, billing: 'enterprise' },
        }),
        'utf8',
      );
      const badResult = await loadBackendsTable(dir);
      expect(badResult.ok).toBe(false);
      if (badResult.ok) return;
      expect(badResult.error).toBe('BAD_RECORD');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
