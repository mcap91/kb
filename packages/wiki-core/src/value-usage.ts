/**
 * Value-usage module — the owned token read + LiteLLM-table cost surface (DEC-0005 / WK-0064).
 *
 * Reads the local CLI session logs DIRECTLY (no external CLI shell-out), repo-attributes them, prices them
 * against a vendored + pinned LiteLLM table, and aggregates by model AND by provider:
 *
 *  - Claude Code writes `~/.claude/projects/<encoded-cwd>/**\/*.jsonl` (incl. `subagents/`
 *    subfolders). We parse each assistant line's `message.usage` + `message.model` + top-level
 *    `timestamp`, dedupe on `message.id`, window by date, and repo-scope by the encoded-cwd
 *    folder key. A `<synthetic>` 0-token pseudo-model is skipped.
 *  - Codex is a separate CLI (`~/.codex/sessions/.../rollout-*.jsonl`). `session_meta.cwd` /
 *    `turn_context.cwd` carry the launch directory, so a cwd prefix-match attributes codex usage
 *    to the repo; `turn_context.effort` carries the optional reasoning-effort dimension.
 *
 * Cost model (DEC-0005, amended 2026-08-17 per operator):
 *  - cost_usd_est  `tokens × table` at LiteLLM list rates, per model; provider = litellm_provider.
 *                  Unknown model → null + reason (never a silent $0). The estimate is NOT a bill.
 *  - cost_usd      the actual out-of-pocket $. No API returns a per-repo/per-span dollar figure, so
 *                  the tool never fabricates one: cost_usd is always null (+ actual_reason). Only an
 *                  operator hand-editing the record supplies a real number. (The former OpenRouter
 *                  /credits reconciliation was removed: /credits is an ACCOUNT-LIFETIME total, not
 *                  span-scoped, so it produced the same stale figure on every report.)
 *
 * OpenRouter is still reported as a PROVIDER when its models ran through Claude Code — those tokens
 * are in the `~/.claude` JSONL and priced by the table like any other model. Only the meaningless
 * lifetime-dollar layer is gone.
 *
 * Worktree-agnostic attribution via `git worktree list --porcelain` roots. A worktree REMOVED
 * before the scrape drops its tokens (cut the VAL while worktrees exist) — stated limitation.
 *
 * Public API: computeValueUsage(opts, deps?) → Promise<Result<UsageMetrics>>
 *
 * Rules:
 * - Result<T> everywhere; never throw from computeValueUsage.
 * - The core path is FULLY OFFLINE + deterministic — no network calls at all.
 * - Egress points are injectable via UsageDeps (log readers, pricing-table load).
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
  UsageProviderDetail,
  CostProvenance,
  ModelPatternEntry,
} from './types.js';
import { priceModel, loadDefaultPricingTable, LITELLM_TABLE_VERSION, type PricingTable } from './pricing.js';

// ---------------------------------------------------------------------------
// Normalized read records (Claude + Codex)
// ---------------------------------------------------------------------------

/**
 * One assistant message's usage read from a Claude Code JSONL line. `projectKey` is the
 * encoded-cwd folder name (the repo-scope key); `messageId` is the dedup key.
 */
export interface ClaudeMessageUsage {
  projectKey: string;
  messageId: string;
  model: string;
  /** YYYY-MM-DD from the top-level `timestamp` (the date-window key). */
  date: string;
  input_tokens: number;
  output_tokens: number;
  /** From `message.usage.cache_read_input_tokens`. */
  cache_read_tokens: number;
  /** From `message.usage.cache_creation_input_tokens` (a number). */
  cache_write_tokens: number;
}

/**
 * A single repo-attributable codex session's usage, read from raw ~/.codex logs. Tokens are
 * normalized to the Claude-family shape: `input_tokens` is NON-cached input; `cache_read_tokens`
 * is cached input. Codex has no cache-write bucket. `effort` is the optional reasoning-effort
 * dimension (`turn_context.effort`, e.g. "xhigh"); null when the session did not log one.
 */
export interface CodexSessionUsage {
  /** session_meta.cwd (or turn_context.cwd) — the codex launch directory. */
  cwd: string;
  /** turn_context.model, e.g. "gpt-5.5"; falls back to "codex". */
  model: string;
  effort: string | null;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

// ---------------------------------------------------------------------------
// UsageDeps — injectable seams for testing
// ---------------------------------------------------------------------------

/**
 * The egress points of value-usage, all injectable so tests are hermetic.
 */
export interface UsageDeps {
  /**
   * Read repo-attributable Claude Code assistant-message usage for the date window.
   * Returns records tagged with their encoded-cwd `projectKey`; the caller repo-scopes and
   * dedupes. Returns [] when Claude logs are absent/unreadable. Must never throw.
   */
  readClaudeSessions(since: string, until: string): ClaudeMessageUsage[];

  /**
   * Read raw ~/.codex session logs for the date window and return every session's usage WITH
   * its launch cwd (repo filtering happens in the caller). Returns [] when codex is absent or
   * unreadable. Must never throw.
   */
  readCodexSessions(since: string, until: string): CodexSessionUsage[];

  /**
   * Load the LiteLLM pricing table. Optional: when absent, the vendored, pinned table is read
   * from disk (loadDefaultPricingTable). Injected in tests with a small synthetic table.
   */
  loadPricingTable?(): PricingTable;

  /**
   * Lists additional worktree root paths of the target repo via `git worktree list --porcelain`.
   * Returns [] when git is unavailable or there are no linked worktrees. Must never throw.
   * Optional: absent from a caller-provided deps object → treated as no extra roots ([]).
   */
  listWorktreeRoots?(dir: string): string[];
}

// ---------------------------------------------------------------------------
// Claude Code JSONL reader (owned — mirrors the Codex reader)
// ---------------------------------------------------------------------------

/** Coerce a possibly-absent JSON number field to a finite number (0 when missing/NaN). */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse one Claude Code JSONL file's raw text into per-assistant-message usage records.
 * Only lines carrying `message.usage` are kept (assistant turns); a `<synthetic>` model is
 * skipped. Pure — no dedup, no windowing (the caller owns those). Never throws.
 */
export function parseClaudeJsonl(raw: string, projectKey: string): ClaudeMessageUsage[] {
  const out: ClaudeMessageUsage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let d: unknown;
    try {
      d = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof d !== 'object' || d === null) continue;
    const rec = d as { timestamp?: unknown; message?: unknown };
    const msg = rec.message;
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as { id?: unknown; model?: unknown; usage?: unknown };
    // Only assistant messages carry a usage object.
    if (typeof m.usage !== 'object' || m.usage === null) continue;
    const model = typeof m.model === 'string' ? m.model : '';
    if (!model || model === '<synthetic>') continue; // skip the 0-token pseudo-model
    const u = m.usage as Record<string, unknown>;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : '';
    out.push({
      projectKey,
      messageId: typeof m.id === 'string' ? m.id : '',
      model,
      date: ts.slice(0, 10),
      input_tokens: num(u['input_tokens']),
      output_tokens: num(u['output_tokens']),
      cache_read_tokens: num(u['cache_read_input_tokens']),
      cache_write_tokens: num(u['cache_creation_input_tokens']),
    });
  }
  return out;
}

/** Recursively collect *.jsonl paths under a Claude projects root (incl. subagents/ subfolders). */
function listClaudeJsonl(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) results.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return results;
}

/**
 * Walk a Claude `projects` root, parse every `*.jsonl` (incl. nested `subagents/`), tag each
 * record with its top-level project folder key, and keep records whose per-message date is
 * within [since, until]. Repo-scoping + dedup are the caller's job. Never throws.
 */
export function readClaudeSessionsFrom(
  projectsRoot: string,
  since: string,
  until: string,
): ClaudeMessageUsage[] {
  const out: ClaudeMessageUsage[] = [];
  const files = listClaudeJsonl(projectsRoot);
  for (const file of files) {
    const rel = path.relative(projectsRoot, file);
    const projectKey = rel.split(path.sep)[0] ?? '';
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const r of parseClaudeJsonl(raw, projectKey)) {
      if (r.date && r.date >= since && r.date <= until) out.push(r);
    }
  }
  return out;
}

const defaultReadClaudeSessions: UsageDeps['readClaudeSessions'] = (since, until) =>
  readClaudeSessionsFrom(path.join(os.homedir(), '.claude', 'projects'), since, until);

// ---------------------------------------------------------------------------
// Codex session-log reader (owned)
// ---------------------------------------------------------------------------

/**
 * Default codex reader: walk ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl, keep files whose
 * date is within [since, until], and for each extract the launch cwd, model, effort, and final
 * cumulative token usage. Never throws.
 */
const defaultReadCodexSessions: UsageDeps['readCodexSessions'] = (since, until) => {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const out: CodexSessionUsage[] = [];
  let files: string[];
  try {
    files = listCodexRollouts(sessionsRoot);
  } catch {
    return out;
  }

  for (const file of files) {
    // Date is embedded in the filename: rollout-YYYY-MM-DDThh-...
    const m = path.basename(file).match(/rollout-(\d{4}-\d{2}-\d{2})T/);
    const date = m?.[1];
    if (!date || date < since || date > until) continue;

    const session = readOneCodexRollout(file);
    if (session) out.push(session);
  }
  return out;
};

/** Recursively collect rollout-*.jsonl paths under the codex sessions root. */
function listCodexRollouts(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) results.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return results;
}

/**
 * Parse one codex rollout file: cwd (session_meta / turn_context), model + effort (last
 * turn_context), and the final cumulative total_token_usage. Returns null if the file has no
 * usable token data.
 */
function readOneCodexRollout(file: string): CodexSessionUsage | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }

  let cwd: string | undefined;
  let model: string | undefined;
  let effort: string | null = null;
  let lastUsage: { input: number; cached: number; output: number; total: number } | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let d: unknown;
    try {
      d = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof d !== 'object' || d === null) continue;
    const rec = d as { type?: string; payload?: Record<string, unknown> };
    const payload = rec.payload ?? {};

    if (rec.type === 'session_meta') {
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'] as string;
    }
    if (rec.type === 'turn_context') {
      if (typeof payload['cwd'] === 'string' && !cwd) cwd = payload['cwd'] as string;
      if (typeof payload['model'] === 'string') model = payload['model'] as string;
      if (typeof payload['effort'] === 'string') effort = payload['effort'] as string;
    }
    if (payload['type'] === 'token_count') {
      const info = payload['info'] as { total_token_usage?: Record<string, number> } | undefined;
      const tu = info?.total_token_usage;
      if (tu) {
        lastUsage = {
          input: num(tu['input_tokens']),
          cached: num(tu['cached_input_tokens']),
          output: num(tu['output_tokens']),
          total: num(tu['total_tokens']),
        };
      }
    }
  }

  if (!cwd || !lastUsage) return null;
  // Normalize to Claude-family shape: input_tokens excludes cached; cache_read = cached.
  return {
    cwd,
    model: model ?? 'codex',
    effort,
    input_tokens: Math.max(0, lastUsage.input - lastUsage.cached),
    cache_read_tokens: lastUsage.cached,
    output_tokens: lastUsage.output,
    total_tokens: lastUsage.total,
  };
}

/**
 * Default worktree-root lister: parses `git worktree list --porcelain` and returns EVERY
 * worktree root the repo knows, including the main checkout. The caller dedupes against
 * `targetDir`. Returns [] on any failure (git absent, not a git repo).
 *
 * NOTE: git is a real .exe on Windows — no cmd.exe shim needed.
 */
export const defaultListWorktreeRoots: NonNullable<UsageDeps['listWorktreeRoots']> = (dir) => {
  let raw: string;
  try {
    raw = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return [];
  }

  // Porcelain format: each stanza starts with `worktree <path>`.
  const roots: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim();
      if (p) roots.push(p);
    }
  }
  return roots;
};

const DEFAULT_DEPS: UsageDeps = {
  readClaudeSessions: defaultReadClaudeSessions,
  readCodexSessions: defaultReadCodexSessions,
  loadPricingTable: loadDefaultPricingTable,
  listWorktreeRoots: defaultListWorktreeRoots,
};

// ---------------------------------------------------------------------------
// value-config model_patterns loader (table-key aliases; value-usage-local)
// ---------------------------------------------------------------------------

/**
 * Load model_patterns (table-key aliases) from `wiki/.value-config.json`, best-effort.
 * Returns [] when the file is absent, unreadable, or malformed. Each entry must carry a
 * string `pattern` + a string `table_key`. Never imports value-report's private loadConfig —
 * cross-function reuse would couple otherwise independent code paths.
 */
function loadModelPatterns(dir: string): ModelPatternEntry[] {
  const configPath = path.join(dir, 'wiki', '.value-config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const patterns = parsed['model_patterns'];
    if (!Array.isArray(patterns)) return [];
    const valid: ModelPatternEntry[] = [];
    for (const p of patterns) {
      if (
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>)['pattern'] === 'string' &&
        typeof (p as Record<string, unknown>)['table_key'] === 'string'
      ) {
        valid.push({
          pattern: (p as Record<string, unknown>)['pattern'] as string,
          table_key: (p as Record<string, unknown>)['table_key'] as string,
        });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CWD encoding + repo matching
// ---------------------------------------------------------------------------

/** Encode a cwd the way Claude Code does: replace `:` `\` `/` with `-`. */
function encodeCwd(cwdPath: string): string {
  return cwdPath.replace(/[:\\/]/g, '-');
}

/** True if a project folder key and a repo root encode to the same string. */
function encodedMatches(projectKey: string, targetDir: string): boolean {
  return encodeCwd(projectKey) === encodeCwd(targetDir);
}

/**
 * True if `cwd` is the target repo or a directory under it (codex prefix match).
 * Case-insensitive on Windows. Guards `kb` vs `kb-other` via the separator.
 */
function isUnderDir(cwd: string, targetDir: string): boolean {
  const a = path.resolve(cwd);
  const b = path.resolve(targetDir);
  const na = process.platform === 'win32' ? a.toLowerCase() : a;
  const nb = process.platform === 'win32' ? b.toLowerCase() : b;
  return na === nb || na.startsWith(nb + path.sep);
}

// ---------------------------------------------------------------------------
// Internal row model (source-tagged: claude family vs codex)
// ---------------------------------------------------------------------------

interface UsageRow {
  model: string;
  source: 'claude' | 'codex';
  /** Reasoning effort (Codex only); null for Claude. Part of the merge key. */
  effort: string | null;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
}

/** Combine rows sharing (source, model, effort) — the aggregation key. */
function mergeRows(rows: UsageRow[]): Map<string, UsageRow> {
  const merged = new Map<string, UsageRow>();
  for (const row of rows) {
    const key = `${row.source}::${row.model}::${row.effort ?? ''}`;
    const existing = merged.get(key);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.cache_write_tokens += row.cache_write_tokens;
      existing.cache_read_tokens += row.cache_read_tokens;
      existing.output_tokens += row.output_tokens;
    } else {
      merged.set(key, { ...row });
    }
  }
  return merged;
}

/** Aggregate per-model details into per-provider rows (provider = litellm_provider). */
function aggregateByProvider(models: UsageModelDetail[]): UsageProviderDetail[] {
  const map = new Map<string, UsageProviderDetail>();
  for (const m of models) {
    let p = map.get(m.provider);
    if (!p) {
      p = {
        provider: m.provider,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        cost_usd: null,
        cost_usd_est: null,
      };
      map.set(m.provider, p);
    }
    p.input_tokens += m.input_tokens;
    p.output_tokens += m.output_tokens;
    p.cache_read_tokens += m.cache_read_tokens;
    p.cache_write_tokens += m.cache_write_tokens;
    p.total_tokens += m.total_tokens;
    if (m.cost_usd_est !== null) p.cost_usd_est = (p.cost_usd_est ?? 0) + m.cost_usd_est;
  }
  return [...map.values()];
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
    cost_usd_est: null,
    cost_provenance: 'unavailable',
    pricing_table_version: LITELLM_TABLE_VERSION,
    agents: [],
    by_model: [],
    by_provider: [],
    attribution: 'date-window-approx',
    reason,
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Scrape token/cost usage from the owned Claude + Codex reads, price via the vendored LiteLLM
 * table, reconcile the optional OpenRouter actual, and repo-attribute for the target repo +
 * date window. Self-aware: no data for the span produces `ok()` with
 * `cost_provenance: 'unavailable'` + a machine-readable `reason`, never `fail()`.
 */
export async function computeValueUsage(
  opts: ValueUsageOpts,
  deps: UsageDeps = DEFAULT_DEPS,
): Promise<Result<UsageMetrics>> {
  const targetDir = path.resolve(opts.dir);

  // Compute all repo roots: main checkout + any linked worktrees (deduped, win32 case-insensitive).
  const wtRoots: string[] = deps.listWorktreeRoots ? deps.listWorktreeRoots(targetDir) : [];
  const seenRoots = new Set<string>();
  const roots: string[] = [];
  for (const r of [targetDir, ...wtRoots]) {
    const resolved = path.resolve(r);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seenRoots.has(key)) {
      seenRoots.add(key);
      roots.push(resolved);
    }
  }

  // Table-key aliases: opts.config overrides > file > default []. A [] override clears file aliases.
  const aliases: ModelPatternEntry[] =
    opts.config?.model_patterns !== undefined
      ? opts.config.model_patterns
      : loadModelPatterns(targetDir);

  // Pricing table: injected (tests) or the vendored, pinned default.
  const table: PricingTable = (deps.loadPricingTable ?? loadDefaultPricingTable)();

  // --- Step 1: Claude family via the owned JSONL read (repo-scoped, deduped) ---

  let claudeRows: UsageRow[] = [];
  try {
    const msgs = deps.readClaudeSessions(opts.since, opts.until);
    const inScope = msgs.filter((mm) => roots.some((r) => encodedMatches(mm.projectKey, r)));
    const seen = new Set<string>();
    for (const mm of inScope) {
      if (mm.messageId) {
        if (seen.has(mm.messageId)) continue; // dedup on message id
        seen.add(mm.messageId);
      }
      claudeRows.push({
        model: mm.model,
        source: 'claude',
        effort: null, // Claude logs no effort level
        input_tokens: mm.input_tokens,
        cache_write_tokens: mm.cache_write_tokens,
        cache_read_tokens: mm.cache_read_tokens,
        output_tokens: mm.output_tokens,
      });
    }
  } catch {
    claudeRows = [];
  }

  // --- Step 2: Codex via the owned raw-log read (repo-scoped by cwd prefix) ---

  let codexRows: UsageRow[] = [];
  try {
    const sessions = deps.readCodexSessions(opts.since, opts.until);
    codexRows = sessions
      .filter((s) => roots.some((r) => isUnderDir(s.cwd, r)))
      .map((s) => ({
        model: s.model,
        source: 'codex' as const,
        effort: s.effort,
        input_tokens: s.input_tokens,
        cache_write_tokens: 0,
        cache_read_tokens: s.cache_read_tokens,
        output_tokens: s.output_tokens,
      }));
  } catch {
    codexRows = [];
  }

  const allRows: UsageRow[] = [...claudeRows, ...codexRows];
  if (allRows.length === 0) {
    return ok(unavailableMetrics('no token data for this directory in the given window'));
  }

  // --- Step 3: Merge by (source, model, effort) ---

  const byKey = mergeRows(allRows);

  // --- Step 4: Price each merged row via the LiteLLM table → per-model detail ---

  const modelDetails: UsageModelDetail[] = [];
  for (const [, row] of byKey) {
    const priced = priceModel(
      row.model,
      {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_write_tokens: row.cache_write_tokens,
        cache_read_tokens: row.cache_read_tokens,
      },
      table,
      aliases,
    );
    const total =
      row.input_tokens + row.cache_write_tokens + row.cache_read_tokens + row.output_tokens;
    modelDetails.push({
      model: row.model,
      provider: priced.provider,
      effort: row.effort,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      total_tokens: total,
      cost_usd: null, // actual is top-level only, never split per model
      cost_usd_est: priced.cost_usd_est,
      est_reason: priced.est_reason,
    });
  }

  // --- Step 6: Aggregate by provider + compute totals ---

  const byProvider = aggregateByProvider(modelDetails);

  const totalInputTokens = modelDetails.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutputTokens = modelDetails.reduce((s, m) => s + m.output_tokens, 0);
  const totalCacheRead = modelDetails.reduce((s, m) => s + m.cache_read_tokens, 0);
  const totalCacheWrite = modelDetails.reduce((s, m) => s + m.cache_write_tokens, 0);
  const totalAllTokens = modelDetails.reduce((s, m) => s + m.total_tokens, 0);

  // Estimate: sum whatever priced; null when nothing could be priced (never a fabricated 0).
  const estCosts = modelDetails.map((m) => m.cost_usd_est).filter((c): c is number => c !== null);
  const totalCostUsdEst: number | null =
    estCosts.length > 0 ? estCosts.reduce((s, c) => s + c, 0) : null;

  // --- Step 7: Actual + provenance ---
  // No API returns a per-span dollar figure, so the tool never fabricates an actual: cost_usd is
  // always null. Only an operator hand-editing the record supplies a real number. The estimate
  // (tokens × table) is the interpretable figure.
  const costUsd: number | null = null;
  const provenance: CostProvenance = 'litellm-estimate';
  const actualReason =
    'no per-span actual-dollar source exists; cost is a tokens × LiteLLM-table estimate (list rates, not a bill)';

  // --- Step 8: Agents list (from the owned read sources) ---

  const agents: string[] = [];
  if (claudeRows.length > 0) agents.push('claude');
  if (codexRows.length > 0) agents.push('codex');

  return ok({
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_read_tokens: totalCacheRead,
    cache_write_tokens: totalCacheWrite,
    total_tokens: totalAllTokens,
    cost_usd: costUsd,
    cost_usd_est: totalCostUsdEst,
    cost_provenance: provenance,
    pricing_table_version: LITELLM_TABLE_VERSION,
    ...(actualReason ? { actual_reason: actualReason } : {}),
    agents,
    by_model: modelDetails,
    by_provider: byProvider,
    attribution: 'date-window-approx',
  });
}
