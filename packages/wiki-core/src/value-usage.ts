/**
 * Value-usage module — the ONE kb module that shells npx and makes a network call.
 *
 * Scrapes token/cost usage for the target repo + date window across every arm the
 * user runs, and repo-attributes it:
 *
 *  - Claude family (subscription Claude, local Ollama/OSS, OpenRouter) all run
 *    THROUGH Claude Code, so they share `~/.claude/projects/<encoded-cwd>/*.jsonl`.
 *    `ccusage claude daily --json --instances` reads them, grouped by project cwd
 *    (the encoded-cwd key), and prices them. Arm is identified per model string.
 *  - Codex is a SEPARATE CLI (`~/.codex/sessions/.../rollout-*.jsonl`). ccusage's codex
 *    views expose NO cwd, so codex cannot be repo-scoped via ccusage. Instead we
 *    read the raw session logs directly: `session_meta.cwd` (and `turn_context`)
 *    carry the launch directory — for interactive sessions the repo root, for kb
 *    dispatch runs a subdir under the repo — so a cwd prefix-match attributes
 *    codex usage to the repo. Codex dollars-at-API-rates come from joining the
 *    repo-matched sessions to `ccusage codex session --json` on the session UUID.
 *
 * Worktree-agnostic attribution: sessions run in a git worktree of the repo are
 * attributed via `git worktree list --porcelain` roots (UsageDeps.listWorktreeRoots).
 * A worktree REMOVED before the scrape drops its tokens (cut the VAL while worktrees
 * exist) — deterministic, stated limitation.
 *
 * Dual cost fields (operator decision 2026-07-10):
 *  - cost_usd      real/marginal out-of-pocket: OR → authoritative API $; local → 0;
 *                  subscription (incl. codex-on-subscription) → null (flat fee).
 *  - cost_usd_est  ccusage (LiteLLM) at-API-rates estimate for EVERY arm — the
 *                  interpretable "what it would have metered" figure. Partial codex
 *                  pricing (some sessions unjoinable) sums what it can: downward-biased.
 *
 * Public API: computeValueUsage(opts, deps?) → Promise<Result<UsageMetrics>>
 *
 * Rules:
 * - Result<T> everywhere; never throw from computeValueUsage
 * - Egress points are injectable via UsageDeps (ccusage exec, codex-log read, OR fetch)
 * - NEVER log, echo, or include the OpenRouter key in any returned value or output
 * - Use execFileSync with an arg array (no shell string interpolation) in defaults
 *
 * ccusage `claude daily --json --instances` shape (verified against ccusage 20.0.17):
 * {
 *   projects: {
 *     "<encoded-cwd>": [                 // key = cwd with : \ / replaced by -
 *       {
 *         date, project, inputTokens, outputTokens,
 *         cacheCreationTokens, cacheReadTokens, totalCost, totalTokens,
 *         modelsUsed: string[],
 *         modelBreakdowns: [
 *           { modelName, inputTokens, outputTokens,
 *             cacheCreationTokens, cacheReadTokens, cost }
 *         ]
 *       }
 *     ]
 *   },
 *   totals: { ... }
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
  ModelPatternEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// Pinned ccusage version (spec §2.3: @latest forbidden for reproducibility)
// Config-overridable via opts.ccusageVersion. Verified current 2026-07-10.
// ---------------------------------------------------------------------------

const CCUSAGE_VERSION = '20.0.17';

// ---------------------------------------------------------------------------
// UsageDeps — injectable seams for testing
// ---------------------------------------------------------------------------

/**
 * A single repo-attributable codex session's usage, read from raw ~/.codex logs.
 * Tokens are already normalized to the same shape as the claude family:
 * `input_tokens` is NON-cached input; `cache_read_tokens` is cached input.
 */
export interface CodexSessionUsage {
  /** session_meta.cwd (or turn_context.cwd) — the codex launch directory. */
  cwd: string;
  /** turn_context.model, e.g. "gpt-5.5"; falls back to "codex". */
  model: string;
  /**
   * Rollout session UUID (session_meta.payload.id, or parsed from the rollout
   * filename) — the join key for `ccusage codex session` pricing. Absent when
   * unparseable; such sessions stay tokens-only (cost_usd_est null).
   */
  session_id?: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/**
 * The egress points of value-usage, all injectable so tests are hermetic.
 */
export interface UsageDeps {
  /**
   * Run `npx ccusage@<version> claude daily --json --instances --since --until`.
   * Returns raw stdout string. May throw if ccusage is absent.
   * Covers the whole Claude family (subscription / local / OpenRouter arms).
   */
  runClaudeCcusage(version: string, since: string, until: string): string;

  /**
   * Read raw ~/.codex session logs for the date window and return every
   * session's usage WITH its launch cwd (repo filtering happens in the caller).
   * Returns [] when codex is absent or unreadable. Must never throw for that.
   */
  readCodexSessions(since: string, until: string): CodexSessionUsage[];

  /**
   * Run `npx ccusage@<version> codex session --json --since --until`.
   * Returns raw stdout: the $-lookup table for pricing repo-matched codex
   * sessions by sessionId (cost_usd_est only). May throw if ccusage is absent;
   * pricing is best-effort and tokens never depend on it. Optional so partial
   * test deps stay valid; when absent, codex stays unpriced (est null).
   */
  runCodexCcusageSessions?(version: string, since: string, until: string): string;

  /**
   * OpenRouter credits reconcile: reads key from ~/.claude/arms/secrets.env,
   * calls GET /api/v1/credits. Returns null if key unavailable or call fails.
   * MUST NEVER log or expose the key.
   */
  fetchOpenRouterCredits(): Promise<{ total_credits: number; total_usage: number } | null>;

  /**
   * Lists additional worktree root paths of the target repo via
   * `git worktree list --porcelain`. Returns [] when git is unavailable or
   * there are no linked worktrees. Must never throw.
   * Optional: when absent from a caller-provided deps object, treated as no
   * extra roots ([]) so existing hermetic tests retain today's exact behavior.
   */
  listWorktreeRoots?(dir: string): string[];
}

// ---------------------------------------------------------------------------
// Default real implementations
// ---------------------------------------------------------------------------

/**
 * Shell out to `npx -y <ccArgs...>`.
 * Windows: the `npx.cmd` shim can't be spawned via execFile directly
 * (spawnSync EINVAL — Node's CVE-2024-27980 fix bars .cmd without a shell).
 * Route through cmd.exe (a real .exe) which resolves `npx` on PATH. This is
 * NOT `shell: true`, so args are passed as argv and never re-concatenated.
 */
function execNpx(ccArgs: string[]): string {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/c', 'npx', '-y', ...ccArgs], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return execFileSync('npx', ['-y', ...ccArgs], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const defaultRunClaudeCcusage: UsageDeps['runClaudeCcusage'] = (version, since, until) =>
  execNpx([
    `ccusage@${version}`,
    'claude',
    'daily',
    '--json',
    '--instances',
    '--since',
    since,
    '--until',
    until,
  ]);

const defaultRunCodexCcusageSessions: NonNullable<UsageDeps['runCodexCcusageSessions']> = (
  version,
  since,
  until,
) => execNpx([`ccusage@${version}`, 'codex', 'session', '--json', '--since', since, '--until', until]);

/**
 * Default codex reader: walk ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl,
 * keep files whose date is within [since, until], and for each extract the
 * launch cwd, model, and final cumulative token usage. Never throws.
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
 * Parse one codex rollout file: cwd (session_meta / turn_context), model
 * (last turn_context.model), and the final cumulative total_token_usage.
 * Returns null if the file has no usable token data.
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
  let sessionId: string | undefined;
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
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.id === 'string') sessionId = payload.id;
    }
    if (rec.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && !cwd) cwd = payload.cwd;
      if (typeof payload.model === 'string') model = payload.model;
    }
    if (payload.type === 'token_count') {
      const info = payload.info as { total_token_usage?: Record<string, number> } | undefined;
      const tu = info?.total_token_usage;
      if (tu) {
        lastUsage = {
          input: Number(tu.input_tokens ?? 0),
          cached: Number(tu.cached_input_tokens ?? 0),
          output: Number(tu.output_tokens ?? 0),
          total: Number(tu.total_tokens ?? 0),
        };
      }
    }
  }

  if (!cwd || !lastUsage) return null;
  // Join key fallback: the session UUID is also embedded in the rollout filename.
  if (!sessionId) {
    const fm = path
      .basename(file)
      .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    sessionId = fm?.[1];
  }
  // Normalize to Claude-family shape: input_tokens excludes cached; cache_read = cached.
  return {
    cwd,
    model: model ?? 'codex',
    session_id: sessionId,
    input_tokens: Math.max(0, lastUsage.input - lastUsage.cached),
    cache_read_tokens: lastUsage.cached,
    output_tokens: lastUsage.output,
    total_tokens: lastUsage.total,
  };
}

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

/**
 * Default worktree-root lister: parses `git worktree list --porcelain` and
 * returns EVERY worktree root the repo knows, including the main checkout —
 * no positional assumption about which stanza is `dir` (works when `dir` is
 * itself a linked worktree). The caller dedupes against `targetDir`. Returns
 * [] on any failure (git absent, not a git repo).
 *
 * NOTE: git is a real .exe on Windows — no cmd.exe shim needed (unlike npx.cmd).
 * See execNpx above for why that routing exists only for the npx.cmd shim.
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
  runClaudeCcusage: defaultRunClaudeCcusage,
  readCodexSessions: defaultReadCodexSessions,
  runCodexCcusageSessions: defaultRunCodexCcusageSessions,
  fetchOpenRouterCredits: defaultFetchOpenRouterCredits,
  listWorktreeRoots: defaultListWorktreeRoots,
};

// ---------------------------------------------------------------------------
// value-config model_patterns loader (minimal, value-usage-local, no shared dep)
// ---------------------------------------------------------------------------

/**
 * Load model_patterns from `wiki/.value-config.json` best-effort.
 * Returns [] when the file is absent, unreadable, or malformed.
 * Mirror of value-report's loadConfig pattern (opts > file > default) but
 * minimal: only the model_patterns field is consumed here.
 * IMPORTANT: never import or call value-report.ts's private loadConfig —
 * cross-function reuse would create a hard coupling across otherwise independent
 * code paths.
 */
function loadModelPatterns(dir: string): ModelPatternEntry[] {
  const configPath = path.join(dir, 'wiki', '.value-config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const patterns = parsed['model_patterns'];
    if (!Array.isArray(patterns)) return [];
    // Validate each entry: must have string pattern + valid arm string
    const valid: ModelPatternEntry[] = [];
    const validArms = new Set<string>([
      'subscription',
      'local',
      'openrouter',
      'codex',
      'unknown',
    ]);
    for (const p of patterns) {
      if (
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>)['pattern'] === 'string' &&
        validArms.has(String((p as Record<string, unknown>)['arm']))
      ) {
        valid.push({
          pattern: (p as Record<string, unknown>)['pattern'] as string,
          arm: (p as Record<string, unknown>)['arm'] as UsageArm,
        });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Arm identification (spec §2.3)
// ---------------------------------------------------------------------------

/**
 * Identify the arm from a claude-family model string, consulting config patterns first.
 *
 * Resolution order:
 * 1. `patterns` (from opts.config.model_patterns or wiki/.value-config.json):
 *    case-insensitive substring match; first match wins → its arm.
 * 2. Built-in heuristics:
 *    a. `claude-*` → subscription
 *    b. slash-namespaced (`z-ai/glm-5.2`, `deepseek/deepseek-chat`) → openrouter
 *    c. Provider-namespaced Anthropic / Bedrock region-profile guard:
 *       contains `anthropic.` OR starts with `us.` / `eu.` / `ap.` / `apac.`
 *       → unknown (NEVER local — these are PAYG enterprise endpoints, real $)
 *    d. `name:tag` (colon, not slash) → local
 *    e. anything else → unknown
 *
 * (Codex rows are tagged `codex` at their source, not via this function.)
 *
 * Match rule for patterns: case-insensitive substring. The model id and pattern
 * are both lowercased before comparison; no regex escaping required.
 */
function identifyArm(model: string, patterns: ModelPatternEntry[]): UsageArm {
  // 1. Config patterns first (case-insensitive substring, first match wins)
  const modelLower = model.toLowerCase();
  for (const entry of patterns) {
    if (modelLower.includes(entry.pattern.toLowerCase())) {
      return entry.arm;
    }
  }

  // 2. Built-in heuristics
  if (model.startsWith('claude-')) return 'subscription';
  if (model.includes('/')) return 'openrouter';

  // 2c. Enterprise/gateway guard: provider-namespaced Anthropic ids or
  // Bedrock region-profile prefixes (us. / eu. / ap. / apac.) must NEVER
  // be classified local — they are PAYG endpoints with real marginal cost.
  // With no matching config pattern they degrade to unknown → ccusage-priced.
  if (
    model.includes('anthropic.') ||
    /^(?:us|eu|ap|apac)\./.test(model)
  ) {
    return 'unknown';
  }

  if (model.includes(':')) return 'local';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// CWD encoding + repo matching (spec §2.3)
// ---------------------------------------------------------------------------

/** Encode a cwd the way Claude Code does: replace `:` `\` `/` with `-`. */
function encodeCwd(cwdPath: string): string {
  return cwdPath.replace(/[:\\/]/g, '-');
}

/** True if two paths encode to the same string (claude projects-key match). */
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
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  /**
   * ccusage (LiteLLM) at-API-rates $ estimate. Claude-family rows always carry a
   * number (modelBreakdowns[].cost); codex rows carry the sessionId-joined
   * costUSD, or null when the session couldn't be priced.
   */
  ccusage_est_cost: number | null;
}

// ---------------------------------------------------------------------------
// ccusage claude JSON shape (v20 `claude daily --json --instances`)
// ---------------------------------------------------------------------------

interface CcusageModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface CcusageDayEntry {
  date: string;
  project: string;
  modelBreakdowns?: CcusageModelBreakdown[];
}

interface CcusageClaudeOutput {
  projects: Record<string, CcusageDayEntry[]>;
  totals?: unknown;
}

/**
 * Parse `ccusage claude daily --json --instances` and extract per-model rows
 * for the target repo (matched on encoded-cwd project key against any root in
 * `roots`). `roots` is the deduped list [targetDir, ...worktreeRoots].
 * Returns null if the shape is unrecognizable; [] if no root has an entry.
 */
function parseClaudeInstances(raw: string, roots: string[]): UsageRow[] | null {
  let parsed: CcusageClaudeOutput;
  try {
    parsed = JSON.parse(raw) as CcusageClaudeOutput;
  } catch {
    return null;
  }
  if (!parsed?.projects || typeof parsed.projects !== 'object') return null;

  const rows: UsageRow[] = [];
  for (const [projectKey, dayEntries] of Object.entries(parsed.projects)) {
    if (!roots.some((r) => encodedMatches(projectKey, r))) continue;
    if (!Array.isArray(dayEntries)) continue;
    for (const day of dayEntries) {
      const breakdowns = day?.modelBreakdowns;
      if (!Array.isArray(breakdowns)) continue;
      for (const mb of breakdowns) {
        rows.push({
          model: mb.modelName,
          source: 'claude',
          input_tokens: Number(mb.inputTokens ?? 0),
          cache_write_tokens: Number(mb.cacheCreationTokens ?? 0),
          cache_read_tokens: Number(mb.cacheReadTokens ?? 0),
          output_tokens: Number(mb.outputTokens ?? 0),
          ccusage_est_cost: Number(mb.cost ?? 0),
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ccusage codex session JSON shape (v20 `codex session --json`) — the $ lookup
// table for the sessionId join. `directory` there is the DATE folder, not cwd,
// so it can't repo-scope; only sessionId + costUSD are consumed.
// ---------------------------------------------------------------------------

interface CcusageCodexSession {
  sessionId?: string;
  sessionFile?: string;
  costUSD?: number;
}

/**
 * Extract the bare session UUID from any of the id forms floating around:
 * raw `session_meta.payload.id` (bare UUID), a rollout filename, or ccusage
 * v20's composite `sessionId` (`<Y>/<M>/<D>/rollout-<ISO>-<uuid>` — verified
 * 2026-07-10; NOT the bare UUID the shape was first assumed to be). The UUID
 * is always the tail, so both join sides normalize through this.
 */
const SESSION_UUID_TAIL_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?\s*$/i;

function extractSessionUuid(id: string): string | undefined {
  return id.match(SESSION_UUID_TAIL_RE)?.[1]?.toLowerCase();
}

/**
 * Parse `ccusage codex session --json` into a bare-UUID → costUSD map.
 * Returns null if the shape is unrecognizable (treated as no prices).
 */
function parseCodexSessionPrices(raw: string): Map<string, number> | null {
  let parsed: { sessions?: CcusageCodexSession[] };
  try {
    parsed = JSON.parse(raw) as { sessions?: CcusageCodexSession[] };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.sessions)) return null;

  const prices = new Map<string, number>();
  for (const s of parsed.sessions) {
    const idSource = typeof s?.sessionId === 'string' ? s.sessionId : s?.sessionFile;
    if (typeof idSource !== 'string' || typeof s?.costUSD !== 'number') continue;
    const uuid = extractSessionUuid(idSource);
    if (uuid) prices.set(uuid, s.costUSD);
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Merge rows: combine rows with same (source, model)
// ---------------------------------------------------------------------------

function mergeRows(rows: UsageRow[]): Map<string, UsageRow> {
  const merged = new Map<string, UsageRow>();
  for (const row of rows) {
    const key = `${row.source}::${row.model}`;
    const existing = merged.get(key);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.cache_write_tokens += row.cache_write_tokens;
      existing.cache_read_tokens += row.cache_read_tokens;
      existing.output_tokens += row.output_tokens;
      // Est merge: all-null stays null; otherwise sum what was priced (downward-biased).
      existing.ccusage_est_cost =
        existing.ccusage_est_cost === null && row.ccusage_est_cost === null
          ? null
          : (existing.ccusage_est_cost ?? 0) + (row.ccusage_est_cost ?? 0);
    } else {
      merged.set(key, { ...row });
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
    cost_usd_est: null,
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
 * Scrape token/cost usage from ccusage (claude family) + raw ~/.codex logs
 * (codex) + OpenRouter, repo-attributed for the target repo + date window.
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

  // Compute all repo roots: main checkout + any linked worktrees.
  // deps.listWorktreeRoots is optional: absent on a caller-provided deps object
  // → no extra roots ([] ) so existing hermetic tests keep today's behavior.
  // When deps is wholly absent (real runs), DEFAULT_DEPS includes it.
  const wtRoots: string[] = deps.listWorktreeRoots ? deps.listWorktreeRoots(targetDir) : [];
  // Dedupe by resolved path, case-insensitive on win32 (mirrors isUnderDir normalization).
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

  // Load model_patterns: opts.config overrides > file > default [].
  // opts.config.model_patterns = [] is a valid override (clears file patterns).
  const modelPatterns: ModelPatternEntry[] =
    opts.config?.model_patterns !== undefined
      ? opts.config.model_patterns
      : loadModelPatterns(targetDir);

  // --- Step 1: Claude family via ccusage (repo-filtered by encoded cwd) ---

  let claudeRows: UsageRow[] | null = null;
  let claudeError: string | undefined;
  try {
    const raw = deps.runClaudeCcusage(version, opts.since, opts.until);
    claudeRows = parseClaudeInstances(raw, roots);
    if (claudeRows === null) {
      claudeError = 'ccusage claude output malformed or unparseable';
    }
  } catch (e) {
    claudeError = `ccusage claude failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // --- Step 2: Codex via raw ~/.codex logs (repo-filtered by cwd prefix) ---

  let codexRows: UsageRow[] = [];
  try {
    const sessions = deps.readCodexSessions(opts.since, opts.until);
    const repoSessions = sessions.filter((s) => roots.some((r) => isUnderDir(s.cwd, r)));

    // Price the repo-matched sessions by sessionId join against
    // `ccusage codex session --json` (cost_usd_est only — best-effort; tokens
    // never depend on it, and a failed join degrades to est null, never fail()).
    let codexPrices: Map<string, number> | null = null;
    if (repoSessions.length > 0 && deps.runCodexCcusageSessions) {
      try {
        codexPrices = parseCodexSessionPrices(
          deps.runCodexCcusageSessions(version, opts.since, opts.until),
        );
      } catch {
        codexPrices = null;
      }
    }

    codexRows = repoSessions.map((s) => {
      // Both sides normalize to the bare UUID (ccusage sessionId is composite).
      const uuid = s.session_id !== undefined ? extractSessionUuid(s.session_id) : undefined;
      return {
        model: s.model,
        source: 'codex' as const,
        input_tokens: s.input_tokens,
        cache_write_tokens: 0,
        cache_read_tokens: s.cache_read_tokens,
        output_tokens: s.output_tokens,
        ccusage_est_cost:
          uuid !== undefined && codexPrices?.has(uuid) ? codexPrices.get(uuid)! : null,
      };
    });
  } catch {
    codexRows = [];
  }

  // Claude scrape failed entirely AND no codex rows → unavailable
  if (claudeRows === null && codexRows.length === 0) {
    return ok(unavailableMetrics(claudeError ?? 'ccusage unavailable'));
  }

  const allRows: UsageRow[] = [...(claudeRows ?? []), ...codexRows];

  // Data sources responded but nothing matched this repo in the window
  if (allRows.length === 0) {
    return ok(unavailableMetrics('no token data for this directory in the given window'));
  }

  // --- Step 3: Merge by (source, model) ---

  const byModel = mergeRows(allRows);

  // --- Step 4: Fetch OR credits (single call; key never leaves the dep) ---

  const orCredits = await deps.fetchOpenRouterCredits();

  // --- Step 5: Build per-model detail + compute arm provenances ---

  const modelDetails: UsageModelDetail[] = [];
  const armProvenances = new Set<CostProvenance>();

  // For OR reconcile: sum ccusage-estimated OR cost to weight OR credits allocation
  let totalOrCcusageCost = 0;
  for (const [, row] of byModel) {
    if (row.source === 'claude' && identifyArm(row.model, modelPatterns) === 'openrouter') {
      totalOrCcusageCost += row.ccusage_est_cost ?? 0;
    }
  }
  const orModelCount = [...byModel.values()].filter(
    (r) => r.source === 'claude' && identifyArm(r.model, modelPatterns) === 'openrouter',
  ).length;

  for (const [, row] of byModel) {
    const arm: UsageArm = row.source === 'codex' ? 'codex' : identifyArm(row.model, modelPatterns);
    const inputTokens = row.input_tokens;
    const cacheWrite = row.cache_write_tokens;
    const cacheRead = row.cache_read_tokens;
    const outputTokens = row.output_tokens;
    const total = inputTokens + cacheWrite + cacheRead + outputTokens;

    let costUsd: number | null;
    let armProvenance: CostProvenance;

    switch (arm) {
      case 'subscription':
        // Marginal $: none (flat fee). The at-API-rates figure lives in cost_usd_est.
        costUsd = null;
        armProvenance = 'subscription-covered';
        break;

      case 'codex':
        // Tokens repo-attributed from raw logs; marginal $ none (subscription-
        // covered). At-API-rates $ arrives via the sessionId join (cost_usd_est).
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
          // Authoritative: use OR total_usage (spec §2.3), allocated proportionally
          if (totalOrCcusageCost > 0) {
            costUsd = orCredits.total_usage * ((row.ccusage_est_cost ?? 0) / totalOrCcusageCost);
          } else {
            costUsd = orCredits.total_usage / Math.max(1, orModelCount);
          }
          armProvenance = 'openrouter-api';
        } else {
          // Degrade to ccusage-priced (spec §2.3)
          costUsd = row.ccusage_est_cost ?? 0;
          armProvenance = 'ccusage-priced';
        }
        break;

      default:
        // unknown arm — use ccusage pricing
        costUsd = row.ccusage_est_cost ?? 0;
        armProvenance = 'ccusage-priced';
        break;
    }

    armProvenances.add(armProvenance);
    modelDetails.push({
      model: row.model,
      arm,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: total,
      cost_usd: costUsd,
      // At-API-rates estimate for every arm; null only when unpriceable (codex join miss)
      cost_usd_est: row.ccusage_est_cost,
    });
  }

  // --- Step 6: Compute totals ---

  const totalInputTokens = modelDetails.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutputTokens = modelDetails.reduce((s, m) => s + m.output_tokens, 0);
  const totalCacheRead = modelDetails.reduce((s, m) => s + m.cache_read_tokens, 0);
  const totalCacheWrite = modelDetails.reduce((s, m) => s + m.cache_write_tokens, 0);
  const totalAllTokens = modelDetails.reduce((s, m) => s + m.total_tokens, 0);

  // Cost: sum numeric costs; pure tokens-only (subscription/codex) → null.
  let totalCostUsd: number | null = null;
  const numericCosts = modelDetails.map((m) => m.cost_usd).filter((c): c is number => c !== null);
  const allTokensOnly = modelDetails.every((m) => m.arm === 'subscription' || m.arm === 'codex');

  if (allTokensOnly) {
    totalCostUsd = null;
  } else if (numericCosts.length > 0) {
    totalCostUsd = numericCosts.reduce((s, c) => s + c, 0);
  }

  // At-API-rates estimate: sum whatever was priced; null when nothing was.
  const estCosts = modelDetails
    .map((m) => m.cost_usd_est)
    .filter((c): c is number => c !== null);
  const totalCostUsdEst: number | null =
    estCosts.length > 0 ? estCosts.reduce((s, c) => s + c, 0) : null;

  // --- Step 7: Overall provenance ---

  let overallProvenance: CostProvenance;
  if (armProvenances.size === 1) {
    overallProvenance = [...armProvenances][0]!;
  } else {
    overallProvenance = 'mixed';
  }

  // --- Step 8: Agents list (repo-attributable arms only) ---

  const agents: string[] = [];
  if (modelDetails.some((m) => m.arm !== 'codex')) agents.push('claude');
  if (modelDetails.some((m) => m.arm === 'codex')) agents.push('codex');

  return ok({
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_read_tokens: totalCacheRead,
    cache_write_tokens: totalCacheWrite,
    total_tokens: totalAllTokens,
    cost_usd: totalCostUsd,
    cost_usd_est: totalCostUsdEst,
    cost_provenance: overallProvenance,
    agents,
    by_model: modelDetails,
    attribution: 'date-window-approx',
  });
}
