/**
 * Value-usage module — the ONE kb module that shells npx and makes a network call.
 *
 * Runs `ccusage` for both the `claude` and `codex` tools, filters instances to the
 * target repo by the encoded-cwd rule, identifies arms by model string, and assigns
 * cost provenance in code. Self-aware: missing/empty data is DATA (`ok()` with
 * cost_provenance: unavailable + reason), never a failure.
 *
 * Public API: computeValueUsage(opts, deps?) → Promise<Result<UsageMetrics>>
 *
 * Rules:
 * - Result<T> everywhere; never throw from computeValueUsage
 * - Exactly two egress points: runCcusage + fetchOpenRouterCredits — both injectable via UsageDeps
 * - NEVER log, echo, or include the OpenRouter key in any returned value or output
 * - Use execFileSync with arg array (no shell string interpolation) in the default impl
 *
 * Assumed ccusage --json --instances shape (verified against model-usage skill, spec §2.3):
 * {
 *   daily: Array<{
 *     date: string;               // "YYYY-MM-DD"
 *     projects: Array<{
 *       projectPath: string;      // unencoded cwd, e.g. "C:\Users\mcap9\projects\kb"
 *       models: Array<{
 *         model: string;
 *         input_tokens: number;
 *         cache_creation_input_tokens: number;
 *         cache_read_input_tokens: number;
 *         output_tokens: number;
 *         cost_usd: number;       // ccusage LiteLLM-priced estimate
 *       }>
 *     }>
 *   }>
 * }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ok, type Result } from './errors.js';
import type {
  ValueUsageOpts,
  UsageMetrics,
  UsageModelDetail,
  UsageArm,
  CostProvenance,
} from './types.js';

// ---------------------------------------------------------------------------
// Pinned ccusage version (spec §2.3: @latest forbidden for reproducibility)
// Config-overridable via opts.ccusageVersion
// ---------------------------------------------------------------------------

const CCUSAGE_VERSION = '0.8.0';

// ---------------------------------------------------------------------------
// UsageDeps — injectable seams for testing
// ---------------------------------------------------------------------------

/**
 * The two egress points of value-usage, both injectable so tests are hermetic.
 */
export interface UsageDeps {
  /**
   * Run `npx ccusage@<version> <tool> daily --json --since --until --instances`.
   * Returns raw stdout string. May throw if ccusage is absent.
   */
  runCcusage(tool: 'claude' | 'codex', version: string, since: string, until: string): string;

  /**
   * OpenRouter credits reconcile: reads key from ~/.claude/arms/secrets.env,
   * calls GET /api/v1/credits. Returns null if key unavailable or call fails.
   * MUST NEVER log or expose the key.
   */
  fetchOpenRouterCredits(): Promise<{ total_credits: number; total_usage: number } | null>;
}

// ---------------------------------------------------------------------------
// Default real implementations
// ---------------------------------------------------------------------------

const defaultRunCcusage: UsageDeps['runCcusage'] = (tool, version, since, until) => {
  return execFileSync(
    'npx',
    [`ccusage@${version}`, tool, 'daily', '--json', `--since=${since}`, `--until=${until}`, '--instances'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
};

const defaultFetchOpenRouterCredits: UsageDeps['fetchOpenRouterCredits'] = async () => {
  // Read key in-process; NEVER log or include in any returned value
  const secretsPath = path.join(os.homedir(), '.claude', 'arms', 'secrets.env');
  let apiKey: string | undefined;
  try {
    const raw = fs.readFileSync(secretsPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^OPENROUTER_API_KEY\s*=\s*(.+)$/);
      if (m) {
        apiKey = m[1].trim();
        break;
      }
    }
  } catch {
    return null;
  }

  if (!apiKey) return null;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { total_credits?: number; total_usage?: number };
    if (typeof json.total_credits !== 'number' || typeof json.total_usage !== 'number') return null;
    return { total_credits: json.total_credits, total_usage: json.total_usage };
  } catch {
    return null;
  }
  // apiKey intentionally not returned, logged, or included in any output
};

const DEFAULT_DEPS: UsageDeps = {
  runCcusage: defaultRunCcusage,
  fetchOpenRouterCredits: defaultFetchOpenRouterCredits,
};

// ---------------------------------------------------------------------------
// Arm identification (spec §2.3)
// ---------------------------------------------------------------------------

/**
 * Identify the arm from a model string:
 * - `claude-*` → subscription
 * - `name:tag` (contains colon, not slash-namespaced) → local
 * - slash-namespaced (`z-ai/glm-5.2`, `deepseek/deepseek-chat`) → openrouter
 * - anything else → unknown
 */
function identifyArm(model: string): UsageArm {
  if (model.startsWith('claude-')) return 'subscription';
  if (model.includes('/')) return 'openrouter';
  if (model.includes(':')) return 'local';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// CWD encoding (spec §2.3)
// Encode dir by replacing `:` `\` `/` with `-`
// ---------------------------------------------------------------------------

function encodeCwd(cwdPath: string): string {
  return cwdPath.replace(/[:\\\/]/g, '-');
}

/**
 * Returns true if the projectPath from ccusage output matches the target dir.
 * Matching is done by comparing encoded forms.
 */
function projectMatchesDir(projectPath: string, targetDir: string): boolean {
  return encodeCwd(projectPath) === encodeCwd(targetDir);
}

// ---------------------------------------------------------------------------
// ccusage JSON shape types (internal; matches assumed shape in module header)
// ---------------------------------------------------------------------------

interface CcusageModelRow {
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface CcusageProject {
  projectPath: string;
  models: CcusageModelRow[];
}

interface CcusageDayEntry {
  date: string;
  projects: CcusageProject[];
}

interface CcusageOutput {
  daily: CcusageDayEntry[];
}

// ---------------------------------------------------------------------------
// Parse and filter ccusage output for the target dir
// ---------------------------------------------------------------------------

/**
 * Parse raw ccusage JSON and extract per-model rows for the target dir.
 * Returns null if JSON is malformed or shape is unexpected.
 */
function parseCcusageOutput(raw: string, targetDir: string): CcusageModelRow[] | null {
  let parsed: CcusageOutput;
  try {
    parsed = JSON.parse(raw) as CcusageOutput;
  } catch {
    return null;
  }

  if (!parsed?.daily || !Array.isArray(parsed.daily)) return null;

  const rows: CcusageModelRow[] = [];
  for (const day of parsed.daily) {
    if (!day.projects || !Array.isArray(day.projects)) continue;
    for (const project of day.projects) {
      if (!projectMatchesDir(project.projectPath, targetDir)) continue;
      if (!project.models || !Array.isArray(project.models)) continue;
      for (const model of project.models) {
        rows.push(model);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Merge model rows: combine rows with same model string
// ---------------------------------------------------------------------------

function mergeModelRows(rows: CcusageModelRow[]): Map<string, CcusageModelRow> {
  const merged = new Map<string, CcusageModelRow>();
  for (const row of rows) {
    const existing = merged.get(row.model);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.cache_creation_input_tokens += row.cache_creation_input_tokens;
      existing.cache_read_input_tokens += row.cache_read_input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.cost_usd += row.cost_usd;
    } else {
      merged.set(row.model, { ...row });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Empty unavailable result
// ---------------------------------------------------------------------------

function unavailableMetrics(reason: string): UsageMetrics {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_usd: null,
    cost_provenance: 'unavailable',
    agents: [],
    by_model: [],
    attribution: 'date-window-approx',
    reason,
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Scrape token/cost usage from ccusage + OpenRouter for the target repo + date window.
 *
 * Self-aware: missing data, ccusage errors, and empty-for-span all produce
 * `ok()` with `cost_provenance: 'unavailable'` + a machine-readable `reason`.
 * Never `fail()` for missing data.
 */
export async function computeValueUsage(
  opts: ValueUsageOpts,
  deps: UsageDeps = DEFAULT_DEPS,
): Promise<Result<UsageMetrics>> {
  const version = opts.ccusageVersion ?? CCUSAGE_VERSION;
  const targetDir = path.resolve(opts.dir);

  // --- Step 1: Run ccusage for both tools ---

  let claudeRows: CcusageModelRow[] | null = null;
  let codexRows: CcusageModelRow[] | null = null;
  let claudeError: string | undefined;
  let codexError: string | undefined;

  try {
    const raw = deps.runCcusage('claude', version, opts.since, opts.until);
    claudeRows = parseCcusageOutput(raw, targetDir);
    if (claudeRows === null) {
      claudeError = 'ccusage claude output malformed or unparseable';
    }
  } catch (e) {
    claudeError = `ccusage claude failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const raw = deps.runCcusage('codex', version, opts.since, opts.until);
    codexRows = parseCcusageOutput(raw, targetDir);
    if (codexRows === null) {
      codexError = 'ccusage codex output malformed or unparseable';
    }
  } catch (e) {
    codexError = `ccusage codex failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Both failed entirely → unavailable
  if (claudeRows === null && codexRows === null) {
    const reason = [claudeError, codexError].filter(Boolean).join('; ') || 'ccusage unavailable';
    return ok(unavailableMetrics(reason));
  }

  // Merge all rows
  const allRows: CcusageModelRow[] = [
    ...(claudeRows ?? []),
    ...(codexRows ?? []),
  ];

  // Empty for span (data exists but no entries match this dir)
  if (allRows.length === 0) {
    return ok(unavailableMetrics('ccusage returned no data for this directory in the given window'));
  }

  // --- Step 2: Merge by model ---

  const byModel = mergeModelRows(allRows);

  // --- Step 3: Fetch OR credits (single call; key never leaves the dep) ---

  const orCredits = await deps.fetchOpenRouterCredits();

  // --- Step 4: Build per-model detail + compute arm provenances ---

  const modelDetails: UsageModelDetail[] = [];
  const armProvenances = new Set<CostProvenance>();

  // For OR reconcile: sum ccusage-estimated OR cost to weight OR credits allocation
  let totalOrCcusageCost = 0;
  for (const [, row] of byModel) {
    if (identifyArm(row.model) === 'openrouter') {
      totalOrCcusageCost += row.cost_usd;
    }
  }

  for (const [modelStr, row] of byModel) {
    const arm: UsageArm = identifyArm(modelStr);
    const inputTokens = row.input_tokens;
    const cacheWrite = row.cache_creation_input_tokens;
    const cacheRead = row.cache_read_input_tokens;
    const outputTokens = row.output_tokens;
    const total = inputTokens + cacheWrite + cacheRead + outputTokens;

    let costUsd: number | null;
    let armProvenance: CostProvenance;

    switch (arm) {
      case 'subscription':
        // Tokens only; NO dollar estimate (spec §2.3)
        costUsd = null;
        armProvenance = 'subscription-covered';
        break;

      case 'local':
        // Always $0 (spec §2.3)
        costUsd = 0;
        armProvenance = 'local-free';
        break;

      case 'openrouter':
        if (orCredits !== null) {
          // Authoritative: use OR total_usage (spec §2.3)
          // When multiple OR models: allocate proportionally by ccusage weight
          if (totalOrCcusageCost > 0) {
            costUsd = orCredits.total_usage * (row.cost_usd / totalOrCcusageCost);
          } else {
            // Can't weight: split equally? Use OR total for this model's contribution
            const orModelCount = [...byModel.values()].filter(r => identifyArm(r.model) === 'openrouter').length;
            costUsd = orCredits.total_usage / Math.max(1, orModelCount);
          }
          armProvenance = 'openrouter-api';
        } else {
          // Degrade to ccusage-priced (spec §2.3)
          costUsd = row.cost_usd;
          armProvenance = 'ccusage-priced';
        }
        break;

      default:
        // unknown arm — use ccusage pricing
        costUsd = row.cost_usd;
        armProvenance = 'ccusage-priced';
        break;
    }

    armProvenances.add(armProvenance);
    modelDetails.push({
      model: modelStr,
      arm,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: total,
      cost_usd: costUsd,
    });
  }

  // --- Step 5: Compute totals ---

  const totalInputTokens = modelDetails.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutputTokens = modelDetails.reduce((s, m) => s + m.output_tokens, 0);
  const totalCacheRead = modelDetails.reduce((s, m) => s + m.cache_read_tokens, 0);
  const totalCacheWrite = modelDetails.reduce((s, m) => s + m.cache_write_tokens, 0);
  const totalAllTokens = modelDetails.reduce((s, m) => s + m.total_tokens, 0);

  // Cost: sum numeric costs; if any model is null (subscription), overall cost is null
  // unless there are other arms with costs
  let totalCostUsd: number | null = null;
  const numericCosts = modelDetails.map(m => m.cost_usd).filter((c): c is number => c !== null);
  const hasSubscriptionOnly = modelDetails.every(m => m.arm === 'subscription');

  if (hasSubscriptionOnly) {
    totalCostUsd = null;
  } else if (numericCosts.length > 0) {
    totalCostUsd = numericCosts.reduce((s, c) => s + c, 0);
  }

  // --- Step 6: Overall provenance ---

  let overallProvenance: CostProvenance;
  if (armProvenances.size === 1) {
    overallProvenance = [...armProvenances][0]!;
  } else {
    overallProvenance = 'mixed';
  }

  // --- Step 7: Agents list ---

  const agents: string[] = [];
  if (claudeRows !== null && claudeRows.length > 0) agents.push('claude');
  if (codexRows !== null && codexRows.length > 0) agents.push('codex');
  // If both had data but both matched dir (already filtered above), include accordingly
  // If no agents detected but we have model data, infer from presence
  if (agents.length === 0 && modelDetails.length > 0) agents.push('claude');

  return ok({
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_read_tokens: totalCacheRead,
    cache_write_tokens: totalCacheWrite,
    total_tokens: totalAllTokens,
    cost_usd: totalCostUsd,
    cost_provenance: overallProvenance,
    agents,
    by_model: modelDetails,
    attribution: 'date-window-approx',
  });
}
