/**
 * Value-usage module — the owned token read + LiteLLM-table cost surface (DEC-0005 / WK-0066).
 *
 * Reads local agentic-coding usage as a UNION of small per-source readers, repo-attributes each,
 * prices `tokens × a vendored + pinned LiteLLM table`, and aggregates by model AND by provider.
 *
 * Sources (situations 1-5 + 7; OpenCode #6 is WK-0067):
 *  - claude   : `~/.claude/projects/<encoded-cwd>/**\/*.jsonl`. Assistant `message.usage` +
 *               `message.model` + top-level `timestamp`; dedup on `message.id`; `<synthetic>`
 *               skipped. Repo-scope by encoded-cwd PREFIX so a dispatch-launched Claude whose cwd
 *               is a `<repo>/.agent-runs/...` subdir still attributes to the repo (situation 5).
 *  - codex    : `~/.codex/sessions/.../rollout-*.jsonl`. `session_meta.cwd` prefix-match.
 *  - dispatch : `<repo>/.agent-runs/runs/**\/metadata/usage.json` — the sentinel the launcher
 *               writes from the last `##KB_USAGE##` stderr line an adapter prints. In-repo path ⇒
 *               exact attribution. Local (ollama endpoint) → est_usd 0; remote (OpenRouter) → priced.
 *
 * Graceful-fallback contract (WK-0066): each reader self-detects its store and returns [] on
 * absent/unreadable/malformed — NEVER throws. The core does `readers.flatMap(safe)` and unions
 * whatever is present; the scrape is "unavailable" (a `reason` set) ONLY when every reader yields zero.
 *
 * Cost model: `est_usd = tokens × table` (list rates), by model + provider. A REMOTE model with no
 * row → null + reason (never a silent $0). LOCAL/self-hosted → est_usd 0 (never null, never a
 * substitute-model counterfactual — DEC-0005 addendum). There is no "actual" layer.
 *
 * Public API: computeValueUsage(opts, deps?) → Promise<Result<UsageMetrics>>. Fully offline +
 * deterministic; Result<T> everywhere; never throws.
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
  UsageRecord,
  SourceReader,
  SourceReaderContext,
} from './types.js';
import { priceModel, loadDefaultPricingTable, LITELLM_TABLE_VERSION, type PricingTable } from './pricing.js';

// ---------------------------------------------------------------------------
// Normalized read records (Claude + Codex raw shapes — the store-access seam)
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
 * is cached input. Codex has no cache-write bucket.
 */
export interface CodexSessionUsage {
  /** session_meta.cwd (or turn_context.cwd) — the codex launch directory. */
  cwd: string;
  /** turn_context.model, e.g. "gpt-5.5"; falls back to "codex". */
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

// ---------------------------------------------------------------------------
// UsageDeps — injectable seams for testing
// ---------------------------------------------------------------------------

/**
 * The egress points of value-usage, all injectable so tests are hermetic. The Claude/Codex seams
 * return RAW, all-repo, date-windowed records (the reader repo-scopes + dedups); the dispatch seam
 * returns already-normalized `UsageRecord`s (its store lives in-repo, so it scopes + windows itself).
 */
export interface UsageDeps {
  /**
   * Read repo-attributable Claude Code assistant-message usage for the date window, tagged with
   * the encoded-cwd `projectKey`. [] when absent/unreadable. Must never throw.
   */
  readClaudeSessions(since: string, until: string): ClaudeMessageUsage[];

  /**
   * Read raw ~/.codex session usage for the date window WITH each session's launch cwd (the reader
   * repo-scopes). [] when codex is absent/unreadable. Must never throw.
   */
  readCodexSessions(since: string, until: string): CodexSessionUsage[];

  /**
   * Read the dispatch `.agent-runs` usage sentinels under the repo roots, windowed + normalized to
   * `UsageRecord`s (source 'dispatch'). Optional: default walks the filesystem. Must never throw.
   */
  readDispatchUsage?(ctx: SourceReaderContext): UsageRecord[];

  /**
   * Load the LiteLLM pricing table. Optional: when absent, the vendored, pinned table is read
   * from disk (loadDefaultPricingTable). Injected in tests with a small synthetic table.
   */
  loadPricingTable?(): PricingTable;

  /**
   * Lists additional worktree root paths of the target repo via `git worktree list --porcelain`.
   * [] when git is unavailable or there are no linked worktrees. Must never throw. Optional.
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
 * date is within [since, until], and for each extract the launch cwd, model, and final cumulative
 * token usage. Never throws.
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
 * Parse one codex rollout file: cwd (session_meta / turn_context), model (last turn_context), and
 * the final cumulative total_token_usage. Returns null if the file has no usable token data.
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
    input_tokens: Math.max(0, lastUsage.input - lastUsage.cached),
    cache_read_tokens: lastUsage.cached,
    output_tokens: lastUsage.output,
    total_tokens: lastUsage.total,
  };
}

// ---------------------------------------------------------------------------
// Dispatch `.agent-runs` usage-sentinel reader (owned; in-repo ⇒ exact attribution)
// ---------------------------------------------------------------------------

/**
 * True when a sentinel endpoint is a LOCAL/self-hosted worker (ollama). Local dispatch runs price
 * to est_usd 0 (DEC-0005 addendum: no substitute-model counterfactual). OpenRouter (`openrouter.ai`)
 * is remote → priced by the table. Matched on the ollama defaults (localhost / loopback / :11434).
 */
export function isLocalEndpoint(endpoint: string): boolean {
  return /localhost|127\.0\.0\.1|::1|:11434|ollama/i.test(endpoint);
}

/** Collect `<root>/.agent-runs/runs/<handoffId>/<RUN-*>/metadata/usage.json` paths under one root. */
function listDispatchUsageFiles(root: string): string[] {
  const runsRoot = path.join(root, '.agent-runs', 'runs');
  const results: string[] = [];
  let handoffs: fs.Dirent[];
  try {
    handoffs = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const h of handoffs) {
    if (!h.isDirectory()) continue;
    const handoffDir = path.join(runsRoot, h.name);
    let runs: fs.Dirent[];
    try {
      runs = fs.readdirSync(handoffDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const r of runs) {
      if (!r.isDirectory()) continue;
      const usagePath = path.join(handoffDir, r.name, 'metadata', 'usage.json');
      if (fs.existsSync(usagePath)) results.push(usagePath);
    }
  }
  return results;
}

/** Read the co-located `meta.json` completed/started date (YYYY-MM-DD) for windowing; '' if absent. */
function dispatchRunDate(usagePath: string): string {
  const metaPath = path.join(path.dirname(usagePath), 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    const ts = meta['completed_at'] ?? meta['started_at'];
    return typeof ts === 'string' ? ts.slice(0, 10) : '';
  } catch {
    return '';
  }
}

/**
 * Default dispatch reader (WK-0066): walk each root's `.agent-runs` bundles, parse every
 * `metadata/usage.json` (the launcher-written sentinel), window by the run's `meta.json` date, and
 * normalize to `UsageRecord`s. In-repo path ⇒ exact attribution (no cwd guessing). A run with no
 * readable meta.json date is INCLUDED (fail-open — dropping real spend is worse than a stale window).
 * Never throws.
 */
export const defaultReadDispatchUsage: NonNullable<UsageDeps['readDispatchUsage']> = (ctx) => {
  const out: UsageRecord[] = [];
  for (const root of ctx.roots) {
    for (const usagePath of listDispatchUsageFiles(root)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(fs.readFileSync(usagePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        continue; // malformed sentinel → skip, never throw
      }
      const model = typeof parsed['model'] === 'string' ? (parsed['model'] as string) : '';
      if (!model) continue;
      const endpoint = typeof parsed['endpoint'] === 'string' ? (parsed['endpoint'] as string) : '';
      const date = dispatchRunDate(usagePath);
      // Window when we have a date; include when we don't (fail-open).
      if (date && (date < ctx.since || date > ctx.until)) continue;
      out.push({
        source: 'dispatch',
        model,
        input_tokens: num(parsed['prompt_tokens']),
        output_tokens: num(parsed['completion_tokens']),
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        date,
        local: isLocalEndpoint(endpoint),
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Worktree roots
// ---------------------------------------------------------------------------

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
  readDispatchUsage: defaultReadDispatchUsage,
  loadPricingTable: loadDefaultPricingTable,
  listWorktreeRoots: defaultListWorktreeRoots,
};

// ---------------------------------------------------------------------------
// CWD encoding + repo matching
// ---------------------------------------------------------------------------

/** Encode a cwd the way Claude Code does: replace `:` `\` `/` with `-`. */
function encodeCwd(cwdPath: string): string {
  return cwdPath.replace(/[:\\/]/g, '-');
}

/**
 * True if a Claude project folder key is the target repo OR a directory under it, by encoded-cwd
 * PREFIX (situation-5 fix, WK-0066): a dispatch-launched Claude runs with cwd =
 * `<repo>/.agent-runs/…`, whose encoded key is `<encodedRoot>-.agent-runs-…` — an exact-equality
 * test (the old `encodedMatches`) silently dropped it. Prefix on the `-` boundary attributes it.
 * Case-insensitive on win32.
 *
 * LIMITATION: Claude's cwd encoding maps `/`, `\`, and `:` all to `-`, so a subdir `kb/other` and a
 * sibling repo `kb-other` encode identically — a `<repo>-<name>` sibling cannot be distinguished
 * from a `<repo>/<name>` subdir on the encoded key alone. Codex (raw paths, `isUnderDir`) keeps the
 * strict sibling guard; for Claude this boundary case is accepted (WK-0066 Notes).
 */
function encodedIsUnder(projectKey: string, targetDir: string): boolean {
  const encRoot = encodeCwd(path.resolve(targetDir));
  const a = process.platform === 'win32' ? projectKey.toLowerCase() : projectKey;
  const b = process.platform === 'win32' ? encRoot.toLowerCase() : encRoot;
  return a === b || a.startsWith(b + '-');
}

/**
 * True if `cwd` is the target repo or a directory under it (codex prefix match on the REAL path).
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
// Pluggable source readers (each repo-scopes + normalizes itself; never throws)
// ---------------------------------------------------------------------------

/** Build the reader union from the (possibly injected) store-access deps. */
function buildReaders(deps: UsageDeps): SourceReader[] {
  return [
    {
      source: 'claude',
      read: ({ since, until, roots }): UsageRecord[] => {
        const msgs = deps.readClaudeSessions(since, until);
        const inScope = msgs.filter((m) => roots.some((r) => encodedIsUnder(m.projectKey, r)));
        const seen = new Set<string>();
        const out: UsageRecord[] = [];
        for (const m of inScope) {
          if (m.messageId) {
            if (seen.has(m.messageId)) continue; // dedup on message id
            seen.add(m.messageId);
          }
          out.push({
            source: 'claude',
            model: m.model,
            input_tokens: m.input_tokens,
            output_tokens: m.output_tokens,
            cache_read_tokens: m.cache_read_tokens,
            cache_write_tokens: m.cache_write_tokens,
            date: m.date,
            local: false,
          });
        }
        return out;
      },
    },
    {
      source: 'codex',
      read: ({ since, until, roots }): UsageRecord[] => {
        const sessions = deps.readCodexSessions(since, until);
        return sessions
          .filter((s) => roots.some((r) => isUnderDir(s.cwd, r)))
          .map((s) => ({
            source: 'codex',
            model: s.model,
            input_tokens: s.input_tokens,
            output_tokens: s.output_tokens,
            cache_read_tokens: s.cache_read_tokens,
            cache_write_tokens: 0,
            date: '', // codex sessions carry no per-session date; the reader already windowed
            local: false,
          }));
      },
    },
    {
      source: 'dispatch',
      read: (ctx): UsageRecord[] => (deps.readDispatchUsage ?? defaultReadDispatchUsage)(ctx),
    },
  ];
}

/** Wrap a reader's read so a throw degrades to [] (the graceful-fallback contract). */
function safeRead(reader: SourceReader, ctx: SourceReaderContext): UsageRecord[] {
  try {
    return reader.read(ctx);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation (by model → by provider)
// ---------------------------------------------------------------------------

/** A model's merged token buckets across the union (local-ness carried for pricing). */
interface MergedModel {
  model: string;
  local: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Merge union records by model id (a model id has one consistent locality). */
function mergeByModel(records: UsageRecord[]): MergedModel[] {
  const map = new Map<string, MergedModel>();
  for (const r of records) {
    const existing = map.get(r.model);
    if (existing) {
      existing.input_tokens += r.input_tokens;
      existing.output_tokens += r.output_tokens;
      existing.cache_read_tokens += r.cache_read_tokens;
      existing.cache_write_tokens += r.cache_write_tokens;
      existing.local = existing.local || !!r.local;
    } else {
      map.set(r.model, {
        model: r.model,
        local: !!r.local,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
      });
    }
  }
  return [...map.values()];
}

/** Aggregate per-model details into per-provider rows (provider = litellm_provider, or 'local'). */
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
        est_usd: null,
      };
      map.set(m.provider, p);
    }
    p.input_tokens += m.input_tokens;
    p.output_tokens += m.output_tokens;
    p.cache_read_tokens += m.cache_read_tokens;
    p.cache_write_tokens += m.cache_write_tokens;
    p.total_tokens += m.total_tokens;
    if (m.est_usd !== null) p.est_usd = (p.est_usd ?? 0) + m.est_usd;
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
    est_usd: null,
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
 * Scrape token/cost usage from the owned union readers (Claude + Codex + dispatch), price via the
 * vendored LiteLLM table, and repo-attribute for the target repo + date window. Self-aware: no data
 * for the span produces `ok()` with a `reason` (unavailable) + zeroed totals, never `fail()`.
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

  // Pricing table: injected (tests) or the vendored, pinned default.
  const table: PricingTable = (deps.loadPricingTable ?? loadDefaultPricingTable)();

  // --- Union the pluggable readers; each self-detects, repo-scopes, and never throws ---
  const ctx: SourceReaderContext = { since: opts.since, until: opts.until, roots };
  const readers = buildReaders(deps);
  const records: UsageRecord[] = readers.flatMap((r) => safeRead(r, ctx));

  if (records.length === 0) {
    return ok(unavailableMetrics('no token data for this directory in the given window'));
  }

  // --- Merge by model, then price each row (local → est_usd 0; remote → tokens × table) ---
  const merged = mergeByModel(records);
  const modelDetails: UsageModelDetail[] = merged.map((m) => {
    const total = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens;
    if (m.local) {
      // Local/self-hosted (dispatch + ollama endpoint) → est_usd 0. Never null, never a
      // substitute-model counterfactual (DEC-0005 addendum).
      return {
        model: m.model,
        provider: 'local',
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cache_read_tokens: m.cache_read_tokens,
        cache_write_tokens: m.cache_write_tokens,
        total_tokens: total,
        est_usd: 0,
        est_reason: null,
      };
    }
    const priced = priceModel(
      m.model,
      {
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cache_write_tokens: m.cache_write_tokens,
        cache_read_tokens: m.cache_read_tokens,
      },
      table,
    );
    return {
      model: m.model,
      provider: priced.provider,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_write_tokens: m.cache_write_tokens,
      total_tokens: total,
      est_usd: priced.est_usd,
      est_reason: priced.est_reason,
    };
  });

  // --- Aggregate by provider + compute totals ---
  const byProvider = aggregateByProvider(modelDetails);

  const totalInputTokens = modelDetails.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutputTokens = modelDetails.reduce((s, m) => s + m.output_tokens, 0);
  const totalCacheRead = modelDetails.reduce((s, m) => s + m.cache_read_tokens, 0);
  const totalCacheWrite = modelDetails.reduce((s, m) => s + m.cache_write_tokens, 0);
  const totalAllTokens = modelDetails.reduce((s, m) => s + m.total_tokens, 0);

  // Estimate: sum whatever priced (local 0s included); null when NOTHING could be priced (never a
  // fabricated 0). A span of only unknown remote models → null; a span of only local runs → 0.
  const estCosts = modelDetails.map((m) => m.est_usd).filter((c): c is number => c !== null);
  const totalEstUsd: number | null =
    estCosts.length > 0 ? estCosts.reduce((s, c) => s + c, 0) : null;

  // Agents / source set: derived from the readers that produced records (not hardcoded).
  const agents = [...new Set(records.map((r) => r.source))].sort();

  return ok({
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_read_tokens: totalCacheRead,
    cache_write_tokens: totalCacheWrite,
    total_tokens: totalAllTokens,
    est_usd: totalEstUsd,
    pricing_table_version: LITELLM_TABLE_VERSION,
    agents,
    by_model: modelDetails,
    by_provider: byProvider,
    attribution: 'date-window-approx',
  });
}
