/**
 * Tests for computeValueUsage (value-usage.ts) — the OWNED read + LiteLLM-table cost
 * surface (WK-0064 / DEC-0005). ccusage is retired: the Claude and Codex token reads are
 * ours, pricing is `tokens × a vendored pinned LiteLLM table`, aggregation is by model AND
 * by provider (+ optional effort), and "actual" is the optional OpenRouter reconciliation.
 *
 * Strategy: inject fake UsageDeps — readClaudeSessions / readCodexSessions return canned
 * normalized records, loadPricingTable returns a small SYNTHETIC table (never the 1.75 MB
 * vendored one). Hermetic and fully offline: no network, no real ~/.claude / ~/.codex access,
 * no ccusage.
 *
 * Host-native synthetic fixtures only (WK-0043): DIR is derived per platform so it is
 * already absolute for the host running the suite (path.resolve is a no-op), symmetric on
 * Windows and Linux/WSL. The paths need not physically exist.
 */

import { describe, it, expect } from 'vitest';
import type {
  UsageDeps,
  ClaudeMessageUsage,
  CodexSessionUsage,
} from '../packages/wiki-core/src/value-usage.js';
import { computeValueUsage } from '../packages/wiki-core/src/value-usage.js';
import type { PricingTable } from '../packages/wiki-core/src/pricing.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? '\\' : '/';
const HOME_ROOT = IS_WIN ? 'C:\\Users\\test\\projects' : '/home/test/projects';
const DIR = `${HOME_ROOT}${SEP}kb`;
const SINCE = '2026-07-01';
const UNTIL = '2026-07-10';

/** The encoded-cwd project key Claude Code emits for DIR (: \ / -> -). */
const ENCODED_DIR = DIR.replace(/[:\\/]/g, '-');

/**
 * A small synthetic LiteLLM table. Rates chosen so every product is clean and the two
 * providers (anthropic / openai) are distinguishable. Cache-write and cache-read carry
 * DISTINCT rates so a "priced at the input rate" regression is caught at the total level.
 */
const SYN_TABLE: PricingTable = {
  'claude-opus-4-8': {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00003,
    cache_creation_input_token_cost: 0.0000125,
    cache_read_input_token_cost: 0.000001,
    litellm_provider: 'anthropic',
  },
  'claude-sonnet-4-6': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_creation_input_token_cost: 0.00000375,
    cache_read_input_token_cost: 0.0000003,
    litellm_provider: 'anthropic',
  },
  'gpt-5.5': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000008,
    cache_read_input_token_cost: 0.0000001,
    litellm_provider: 'openai',
  },
};

function claudeMsg(
  projectKey: string,
  messageId: string,
  model: string,
  toks: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): ClaudeMessageUsage {
  return {
    projectKey,
    messageId,
    model,
    date: '2026-07-05',
    input_tokens: toks.input ?? 0,
    output_tokens: toks.output ?? 0,
    cache_read_tokens: toks.cacheRead ?? 0,
    cache_write_tokens: toks.cacheWrite ?? 0,
  };
}

function codexSession(
  cwd: string,
  model: string,
  input: number,
  cacheRead: number,
  output: number,
  effort: string | null = null,
): CodexSessionUsage {
  return {
    cwd,
    model,
    effort,
    input_tokens: input,
    cache_read_tokens: cacheRead,
    output_tokens: output,
    total_tokens: input + cacheRead + output,
  };
}

/** Base deps: a synthetic pricing table, no worktrees, empty readers. Fully offline. */
function baseDeps(over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    readClaudeSessions: () => [],
    readCodexSessions: () => [],
    loadPricingTable: () => SYN_TABLE,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Repo attribution (target vs other-repo vs worktree)
// ---------------------------------------------------------------------------

describe('attribution — Claude messages are scoped to the target repo', () => {
  it('includes the target project key and excludes a different project key', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 500 }),
        claudeMsg(
          (HOME_ROOT + SEP + 'other').replace(/[:\\/]/g, '-'),
          'b',
          'claude-opus-4-8',
          { input: 9999, output: 9999 },
        ),
      ],
    });

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.input_tokens).toBe(1000);
    expect(result.data.output_tokens).toBe(500);
    expect(result.data.total_tokens).toBe(1500);
    expect(result.data.agents).toContain('claude');
  });

  it('includes a message under a linked worktree project key via listWorktreeRoots', async () => {
    const WT_PATH = HOME_ROOT + SEP + 'kb-wt' + SEP + 'main';
    const WT_ENCODED = WT_PATH.replace(/[:\\/]/g, '-');
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(WT_ENCODED, 'w', 'claude-opus-4-8', { input: 2000, output: 800 }),
      ],
      listWorktreeRoots: () => [WT_PATH],
    });

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_tokens).toBe(2800);
  });

  it('does not double-count when listWorktreeRoots echoes the main dir + duplicates', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 400 }),
      ],
      listWorktreeRoots: () => [DIR, DIR, HOME_ROOT + SEP + 'kb-wt'],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.by_model).toHaveLength(1);
    expect(result.data.total_tokens).toBe(1400);
  });
});

// ---------------------------------------------------------------------------
// Token extraction + dedup
// ---------------------------------------------------------------------------

describe('token extraction — all four buckets, per model', () => {
  it('parses input/output/cache_read/cache_write for a single model', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', {
          input: 1000,
          output: 500,
          cacheRead: 300,
          cacheWrite: 200,
        }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.data;
    expect(d.input_tokens).toBe(1000);
    expect(d.output_tokens).toBe(500);
    expect(d.cache_read_tokens).toBe(300);
    expect(d.cache_write_tokens).toBe(200);
    expect(d.total_tokens).toBe(2000);
    const m = d.by_model[0]!;
    expect(m.model).toBe('claude-opus-4-8');
    expect(m.provider).toBe('anthropic');
    expect(m.effort).toBeNull(); // Claude logs no effort
  });

  it('splits a two-model session into two by_model rows', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 100, output: 40 }),
        claudeMsg(ENCODED_DIR, 'b', 'claude-sonnet-4-6', { input: 200, output: 80 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.by_model).toHaveLength(2);
    expect(result.data.total_tokens).toBe(420);
  });
});

describe('dedup — a repeated message id is counted once', () => {
  it('collapses duplicate message.id records (resumed sessions / mirrored writes)', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'dup', 'claude-opus-4-8', { input: 1000, output: 500 }),
        claudeMsg(ENCODED_DIR, 'dup', 'claude-opus-4-8', { input: 1000, output: 500 }),
        claudeMsg(ENCODED_DIR, 'unique', 'claude-opus-4-8', { input: 10, output: 5 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only one 'dup' + the 'unique' one: 1000+500 + 10+5 = 1515
    expect(result.data.total_tokens).toBe(1515);
  });
});

// ---------------------------------------------------------------------------
// Pricing (tokens × table) + unknown-model null + reason
// ---------------------------------------------------------------------------

describe('pricing — tokens × table with distinct cache rates', () => {
  it('prices a claude model exactly, cost_usd stays null (no per-row actual)', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', {
          input: 1000,
          output: 500,
          cacheRead: 300,
          cacheWrite: 200,
        }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1000*1e-5 + 500*3e-5 + 200*1.25e-5 + 300*1e-6
    //   = 0.01   + 0.015   + 0.0025      + 0.0003   = 0.0278
    const m = result.data.by_model[0]!;
    expect(m.cost_usd_est).toBeCloseTo(0.0278, 10);
    expect(m.cost_usd).toBeNull();
    expect(m.est_reason).toBeNull();
    expect(result.data.cost_usd_est).toBeCloseTo(0.0278, 10);
  });

  it('an unknown model prices to null + an explicit reason (never a silent $0)', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'mystery-model-9', { input: 1000, output: 500 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.data.by_model[0]!;
    expect(m.provider).toBe('unknown');
    expect(m.cost_usd_est).toBeNull();
    expect(m.est_reason).toMatch(/mystery-model-9/);
    // Nothing priceable → total estimate is null, not 0.
    expect(result.data.cost_usd_est).toBeNull();
    // Tokens still counted.
    expect(result.data.total_tokens).toBe(1500);
  });

  it('a dated/gateway model id resolves via a model_patterns alias', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'us.anthropic.claude-opus-4-8-v1:0', { input: 1000, output: 0 }),
      ],
    });
    const result = await computeValueUsage(
      {
        dir: DIR,
        since: SINCE,
        until: UNTIL,
        config: { model_patterns: [{ pattern: 'claude-opus-4-8', table_key: 'claude-opus-4-8' }] },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.data.by_model[0]!;
    expect(m.provider).toBe('anthropic');
    expect(m.cost_usd_est).toBeCloseTo(1000 * 0.00001, 12); // 0.01
  });
});

// ---------------------------------------------------------------------------
// by_provider aggregation
// ---------------------------------------------------------------------------

describe('by_provider — aggregates from litellm_provider', () => {
  it('sums same-provider models into one provider row and splits distinct providers', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 0 }),
        claudeMsg(ENCODED_DIR, 'b', 'claude-sonnet-4-6', { input: 2000, output: 0 }),
      ],
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 500, 0, 0)],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byProv = Object.fromEntries(result.data.by_provider.map((p) => [p.provider, p]));
    expect(Object.keys(byProv).sort()).toEqual(['anthropic', 'openai']);
    // anthropic input = 1000 + 2000 = 3000; openai input = 500
    expect(byProv.anthropic!.input_tokens).toBe(3000);
    expect(byProv.openai!.input_tokens).toBe(500);
    // anthropic est = 1000*1e-5 + 2000*3e-6 = 0.01 + 0.006 = 0.016
    expect(byProv.anthropic!.cost_usd_est).toBeCloseTo(0.016, 10);
    // openai est = 500*1e-6 = 0.0005
    expect(byProv.openai!.cost_usd_est).toBeCloseTo(0.0005, 10);
  });
});

// ---------------------------------------------------------------------------
// effort dimension (Codex logs it; Claude does not)
// ---------------------------------------------------------------------------

describe('effort — optional per-row dimension, Codex only', () => {
  it('carries Codex turn_context.effort and splits distinct efforts of the same model', async () => {
    const deps = baseDeps({
      readCodexSessions: () => [
        codexSession(DIR, 'gpt-5.5', 100, 0, 50, 'xhigh'),
        codexSession(DIR, 'gpt-5.5', 200, 0, 80, 'low'),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const efforts = result.data.by_model.map((m) => m.effort).sort();
    expect(efforts).toEqual(['low', 'xhigh']);
    expect(result.data.by_model.every((m) => m.provider === 'openai')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Codex repo attribution (kept from the pre-ccusage behavior)
// ---------------------------------------------------------------------------

describe('codex — repo attribution by cwd prefix', () => {
  it('includes a dispatch subdir under the repo and excludes other/sibling repos', async () => {
    const deps = baseDeps({
      readCodexSessions: () => [
        codexSession(
          DIR + SEP + '.agent-runs' + SEP + 'RUN-x' + SEP + 'agent-visible',
          'gpt-5.5',
          100,
          200,
          50,
        ),
        codexSession(HOME_ROOT + SEP + 'other-repo', 'gpt-5.5', 99999, 0, 99999),
        codexSession(HOME_ROOT + SEP + 'kb-sandbox', 'gpt-5.5', 88888, 0, 88888), // sibling prefix
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_tokens).toBe(350); // only the .agent-runs session
    expect(result.data.input_tokens).toBe(100);
  });

  it('sums Claude + Codex in the same window; agents lists both', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 400 }),
      ],
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 200, 0, 100)],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_tokens).toBe(1700);
    expect(result.data.agents.sort()).toEqual(['claude', 'codex']);
    expect(result.data.by_model).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Actual is never fabricated (no OpenRouter lifetime figure; no per-span dollar API)
// ---------------------------------------------------------------------------

describe('actual — never fabricated; cost_usd is always null + reason', () => {
  it('leaves cost_usd null with an actual_reason and litellm-estimate provenance', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 500 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cost_usd).toBeNull();
    expect(result.data.actual_reason).toBeTruthy();
    expect(result.data.cost_provenance).toBe('litellm-estimate');
    // The tokens × table estimate is the interpretable figure.
    expect(result.data.cost_usd_est).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Provenance stamp + self-awareness
// ---------------------------------------------------------------------------

describe('provenance — pinned table version is stamped', () => {
  it('surfaces the LiteLLM table version on every result', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 10, output: 5 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pricing_table_version).toContain('94a29e07');
  });
});

describe('self-aware — no token data for the span is ok(), not fail()', () => {
  it('returns unavailable provenance + reason + zeroed totals when nothing matches', async () => {
    const deps = baseDeps(); // empty readers
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true); // MUST be ok(), never fail()
    if (!result.ok) return;
    expect(result.data.cost_provenance).toBe('unavailable');
    expect(result.data.reason).toBeDefined();
    expect(result.data.total_tokens).toBe(0);
    expect(result.data.by_model).toEqual([]);
    expect(result.data.by_provider).toEqual([]);
    expect(result.data.cost_usd).toBeNull();
    expect(result.data.cost_usd_est).toBeNull();
  });
});

// (The former "secrets never logged" test was removed with the OpenRouter layer — the tool no
// longer reads any key or makes any network call, so there is no secret to leak.)
