/**
 * Tests for the vendored-LiteLLM pricing layer (pricing.ts) — DEC-0005 / WK-0064.
 *
 * TDD: written before the implementation. Pricing is the correctness point of the
 * owned cost surface: tokens × a pinned rate table, with cache-write and cache-read
 * priced at their DISTINCT rates (not the input rate) and an unknown model yielding
 * null + an explicit reason (never a silent $0).
 *
 * The synthetic TABLE below encodes the REAL LiteLLM field shape verified from the
 * vendored table (SRC-0005): input_cost_per_token, output_cost_per_token,
 * cache_creation_input_token_cost, cache_read_input_token_cost, litellm_provider.
 */

import { describe, it, expect } from 'vitest';
import {
  priceModel,
  resolveModelEntry,
  loadDefaultPricingTable,
  LITELLM_TABLE_VERSION,
  type PricingTable,
  type TokenBuckets,
} from '../packages/wiki-core/src/pricing.js';

// Rates chosen so every bucket lands on a clean, independently checkable product.
const TABLE: PricingTable = {
  'claude-opus-4-8': {
    input_cost_per_token: 0.000005, // 5e-6
    output_cost_per_token: 0.000025, // 25e-6
    cache_creation_input_token_cost: 0.00000625, // 6.25e-6 (cache-WRITE, distinct)
    cache_read_input_token_cost: 0.0000005, // 5e-7 (cache-READ, distinct)
    litellm_provider: 'anthropic',
  },
  'gpt-5.5': {
    input_cost_per_token: 0.000001, // 1e-6
    output_cost_per_token: 0.000008, // 8e-6
    cache_read_input_token_cost: 0.0000001, // 1e-7 — NOTE: no cache-write rate on this row
    litellm_provider: 'openai',
  },
};

const buckets = (
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
): TokenBuckets => ({
  input_tokens: input,
  output_tokens: output,
  cache_write_tokens: cacheWrite,
  cache_read_tokens: cacheRead,
});

describe('priceModel — exact key, all four buckets at their distinct rates', () => {
  it('prices input/output/cache-write/cache-read each at its own rate', () => {
    const priced = priceModel('claude-opus-4-8', buckets(1000, 500, 200, 300), TABLE, []);
    // 1000*5e-6 + 500*25e-6 + 200*6.25e-6 + 300*5e-7
    //   = 0.005    + 0.0125   + 0.00125    + 0.00015   = 0.0189
    expect(priced.cost_usd_est).toBeCloseTo(0.0189, 10);
    expect(priced.provider).toBe('anthropic');
    expect(priced.table_key).toBe('claude-opus-4-8');
    expect(priced.est_reason).toBeNull();
  });

  it('cache-write is NOT priced at the input rate (regression guard on the distinct rate)', () => {
    // Only cache-write tokens: must use 6.25e-6, not the 5e-6 input rate.
    const priced = priceModel('claude-opus-4-8', buckets(0, 0, 1000, 0), TABLE, []);
    expect(priced.cost_usd_est).toBeCloseTo(1000 * 0.00000625, 12); // 0.00625, not 0.005
  });

  it('cache-read is NOT priced at the input rate (regression guard on the distinct rate)', () => {
    const priced = priceModel('claude-opus-4-8', buckets(0, 0, 0, 1000), TABLE, []);
    expect(priced.cost_usd_est).toBeCloseTo(1000 * 0.0000005, 12); // 0.0005, not 0.005
  });
});

describe('priceModel — missing per-bucket rate degrades that bucket to 0, never crashes', () => {
  it('a model row without a cache-write rate prices cache-write at 0', () => {
    // gpt-5.5 has no cache_creation_input_token_cost. cache-write tokens contribute 0.
    const priced = priceModel('gpt-5.5', buckets(1000, 500, 400, 200), TABLE, []);
    // 1000*1e-6 + 500*8e-6 + 400*0 + 200*1e-7 = 0.001 + 0.004 + 0 + 0.00002 = 0.00502
    expect(priced.cost_usd_est).toBeCloseTo(0.00502, 10);
    expect(priced.provider).toBe('openai');
  });
});

describe('priceModel — unknown model yields null + explicit reason (never $0)', () => {
  it('returns cost_usd_est null, provider unknown, and a machine-readable reason', () => {
    const priced = priceModel('some-unlisted-model-x', buckets(1000, 1000, 0, 0), TABLE, []);
    expect(priced.cost_usd_est).toBeNull();
    expect(priced.provider).toBe('unknown');
    expect(priced.table_key).toBeNull();
    expect(priced.est_reason).toBeTruthy();
    expect(priced.est_reason).toMatch(/some-unlisted-model-x/);
  });
});

describe('resolveModelEntry — alias resolves gateway/dated ids to a table row', () => {
  it('exact key wins with no alias needed', () => {
    const r = resolveModelEntry('gpt-5.5', TABLE, []);
    expect(r?.table_key).toBe('gpt-5.5');
  });

  it('a provider-prefixed gateway id resolves via a substring alias (WK-0036 → pricing)', () => {
    const gateway = 'us.anthropic.claude-opus-4-8-v1:0';
    // No exact row for the gateway id...
    expect(resolveModelEntry(gateway, TABLE, [])).toBeNull();
    // ...but an alias mapping the substring to the canonical key resolves it.
    const r = resolveModelEntry(gateway, TABLE, [
      { pattern: 'claude-opus-4-8', table_key: 'claude-opus-4-8' },
    ]);
    expect(r?.table_key).toBe('claude-opus-4-8');
    expect(r?.entry.litellm_provider).toBe('anthropic');
  });

  it('first matching alias wins; a non-matching alias is skipped', () => {
    const r = resolveModelEntry('anthropic/claude-opus-4-8', TABLE, [
      { pattern: 'no-match-zzz', table_key: 'gpt-5.5' },
      { pattern: 'claude-opus-4-8', table_key: 'claude-opus-4-8' },
    ]);
    expect(r?.table_key).toBe('claude-opus-4-8');
  });

  it('an alias pointing at a table_key that does not exist is ignored (no false resolve)', () => {
    const r = resolveModelEntry('weird-model', TABLE, [
      { pattern: 'weird', table_key: 'not-in-table' },
    ]);
    expect(r).toBeNull();
  });
});

describe('loadDefaultPricingTable — the vendored, pinned table wires up', () => {
  it('reads the vendored file and resolves a known 2026 model to its provider', () => {
    const table = loadDefaultPricingTable();
    // Loose assertion (robust to a later table refresh): the model resolves and prices > 0.
    const priced = priceModel('claude-opus-4-8', buckets(1000, 1000, 0, 0), table, []);
    expect(priced.provider).toBe('anthropic');
    expect(priced.table_key).toBe('claude-opus-4-8');
    expect(priced.cost_usd_est).toBeGreaterThan(0);
  });

  it('stamps a pinned table version for provenance', () => {
    expect(LITELLM_TABLE_VERSION).toBeTruthy();
    expect(LITELLM_TABLE_VERSION).toContain('94a29e07');
  });
});
