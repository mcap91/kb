/**
 * pricing.ts — price token buckets against a vendored, version-pinned LiteLLM table.
 *
 * DEC-0005 / WK-0064: the cost estimate is `tokens × table` — exactly and only what
 * ccusage did — but reproducible (pinned, not a floating CLI), provider-agnostic (the
 * table carries `litellm_provider`), and offline. This module owns the multiply and the
 * model-id → table-key resolution; value-usage owns the token read and aggregation.
 *
 * The four buckets are priced at their DISTINCT per-token rates:
 *   input  × input_cost_per_token
 *   output × output_cost_per_token
 *   cache-write × cache_creation_input_token_cost   (~+25% of input; the accuracy lever)
 *   cache-read  × cache_read_input_token_cost       (~−90% of input)
 * A model whose id is not an exact table key prices to `null` + an explicit reason —
 * never a silent $0 (which would undercount real spend), never a substitute rate.
 *
 * Pure + offline except `loadDefaultPricingTable`, which reads the vendored JSON off disk.
 * No Result<T> here: this is an internal helper, not a public wiki-core API surface;
 * `priceModel` is total (never throws) and encodes failure as `cost_usd_est: null`.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The pinned provenance stamp for the vendored table. Vendored from
 * github.com/BerriAI/litellm at this commit (fields: input_cost_per_token,
 * output_cost_per_token, cache_creation_input_token_cost, cache_read_input_token_cost,
 * litellm_provider). Refresh cadence + hash live in DEC-0005; this string is surfaced
 * as the cost provenance line in the VAL Token Detail.
 */
export const LITELLM_TABLE_VERSION = 'BerriAI/litellm@94a29e07085dd9d8f2269ee93e899ef0e374cdc7';

/** One LiteLLM price-table row (only the fields we consume; all optional/defensive). */
export interface LitellmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  litellm_provider?: string;
}

/** The whole vendored table: model key → row. */
export type PricingTable = Record<string, LitellmEntry>;

/** The four repo-attributed token buckets for one model. */
export interface TokenBuckets {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

/** The result of pricing one model: provider + list-rate estimate (or null + reason). */
export interface PricedModel {
  /** `litellm_provider` of the resolved row, or `'unknown'` when unmatched. */
  provider: string;
  /** The resolved table key, or null when no row matched. */
  table_key: string | null;
  /** tokens × table at list rates, or null when the model has no price row. */
  est_usd: number | null;
  /** Why the estimate is null (unknown model), else null. Never a silent $0. */
  est_reason: string | null;
}

/**
 * Resolve a raw model id to a table row by EXACT key only (WK-0066: the model-id → table-key
 * override mechanism was removed on operator direction — "either it's in the table or it fails
 * loud"). The id either matches a vendored LiteLLM key or it doesn't; there is no alias table, no
 * namespace transform, no substitute rate. Returns null when the id is not an exact key.
 */
export function resolveModelEntry(
  model: string,
  table: PricingTable,
): { table_key: string; entry: LitellmEntry } | null {
  const entry = table[model];
  return entry ? { table_key: model, entry } : null;
}

/**
 * Price one model's token buckets against the table (exact key only). Each bucket is multiplied
 * by its own rate; a rate absent from the row degrades that bucket to 0 (not to the input
 * rate). A model whose id is not an exact table key prices to null + reason (fail loud — never a
 * silent $0, never a substitute rate). Total function — never throws.
 */
export function priceModel(
  model: string,
  buckets: TokenBuckets,
  table: PricingTable,
): PricedModel {
  const resolved = resolveModelEntry(model, table);
  if (!resolved) {
    return {
      provider: 'unknown',
      table_key: null,
      est_usd: null,
      est_reason: `no LiteLLM price row for model "${model}"`,
    };
  }

  const { entry, table_key } = resolved;
  const est_usd =
    buckets.input_tokens * (entry.input_cost_per_token ?? 0) +
    buckets.output_tokens * (entry.output_cost_per_token ?? 0) +
    buckets.cache_write_tokens * (entry.cache_creation_input_token_cost ?? 0) +
    buckets.cache_read_tokens * (entry.cache_read_input_token_cost ?? 0);

  return {
    provider: entry.litellm_provider ?? 'unknown',
    table_key,
    est_usd,
    est_reason: null,
  };
}

// ---------------------------------------------------------------------------
// Vendored-table loader
// ---------------------------------------------------------------------------

let cachedTable: PricingTable | null = null;

/**
 * Load the vendored, pinned LiteLLM table from `./pricing/litellm-prices.json`
 * (resolved via import.meta.url so it works from src under tsx and from any cwd).
 * Cached after the first read. Returns `{}` if the file is missing or malformed —
 * every model then prices to null + reason, never a fabricated $0.
 */
export function loadDefaultPricingTable(): PricingTable {
  if (cachedTable) return cachedTable;
  try {
    const p = fileURLToPath(new URL('./pricing/litellm-prices.json', import.meta.url));
    cachedTable = JSON.parse(fs.readFileSync(p, 'utf-8')) as PricingTable;
  } catch {
    cachedTable = {};
  }
  return cachedTable;
}
