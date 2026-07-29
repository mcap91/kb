/**
 * Value-report module — deterministic, offline half of the VAL agent-value report.
 *
 * Reads git history + wiki/.graph.json and computes:
 * - Commit-watermark scope and chain status
 * - Unit classification with evidence ladder (tested / wired / linked / candidate / survives)
 * - Churn calculation
 * - LOC reference per unit (net_loc / loc_per_day — tripwire for agent estimation)
 *
 * Public API: computeValueReport(opts) → Result<ValueMetrics>
 *
 * Rules:
 * - Result<T> everywhere; never throw
 * - Offline only: node:child_process git + node:fs (no network)
 * - NEVER import graph-explore (cross-subsystem import is forbidden)
 * - Use execFileSync with arg arrays to avoid Windows shell pipe-parsing issues
 * - Tool measures facts only; estimation arithmetic lives in the template/agent layer
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ok, fail, type Result } from './errors.js';
import type {
  ValueReportOpts,
  ValueMetrics,
  ValueConfig,
  ValueCandidate,
  ValueUnitDetail,
  ValueReviewUnit,
  UnitClass,
  UnitClassCounts,
  ChainStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Graph artifact types (consumed read-only; must not import graph-explore)
// ---------------------------------------------------------------------------

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

interface GraphExport {
  generated_at: string;
  nodes: Array<{ id: string; kind: string; exists?: boolean }>;
  edges: GraphEdge[];
  orphans: string[];
}

// ---------------------------------------------------------------------------
// Config defaults (measurement knobs only — no estimator constants)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ValueConfig = {
  // Corpus-wide throughput floor / per-unit loc_reference tripwire.
  // calibrated from SRC-0002, 661 included units, git-dated 2022-12-01→2026-06-24, poll 2026-07-29
  // = 129,447 net LOC ÷ 498 distinct operator active-days = 259.9 → 260. Replaces the asserted 150
  // (WK-0041 flagged 150 as un-cited). Cross-validated leave-one-section-out to within 2× (median
  // 0.92), conservative-biased. Drives loc_reference only (the >3× per-unit tripwire) — the human-day
  // estimate uses the per-class tier rates in the template anchor table, not this constant.
  loc_per_day: 260,
  ccusage_version: '20.0.17',
  exclude_globs: [
    'scratch_space/**',
    'experiments/**',
    'sandbox/**',
    '**/*_adhoc*',
    '**/pilot_*',
  ],
  classification_patterns: {
    script_extensions: [
      '.py', '.R', '.r', '.Rmd', '.qmd', '.ipynb',
      '.sh', '.bash', '.zsh', '.pl',
      '.ts', '.js', '.java', '.sql',
      '.nf', '.smk', '.wdl', '.cwl',
    ],
    candidate_locations: [
      'analysis/**',
      'scripts/**',
      'notebooks/**',
      'workflows/**',
      'pipelines/**',
      'bin/**',
      'tools/**',
    ],
    test_patterns: [
      '**/test_*.py',
      '**/*_test.py',
      '**/*.test.*',
      '**/tests/**',
      '**/testthat/**',
    ],
    module_patterns: [
      '**/__init__.py',
      '**/index.ts',
      '**/index.js',
    ],
    doc_patterns: [
      '**/*.md',
      '**/*.rst',
      '**/*.html',
    ],
  },
};

// Empty git tree SHA — used as the "before everything" ref for root commits
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------------------
// Git shell-out helpers (execFileSync avoids Windows shell pipe issues)
// ---------------------------------------------------------------------------

/**
 * Run git with an array of arguments.
 * Returns stdout string (trimmed) or null on failure.
 */
function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir: string): boolean {
  return git(dir, 'rev-parse', '--git-dir') !== null;
}

function resolveHead(dir: string): string | null {
  return git(dir, 'rev-parse', 'HEAD');
}

function resolveFirstCommit(dir: string): string | null {
  return git(dir, 'rev-list', '--max-parents=0', 'HEAD');
}

/**
 * Returns true if ancestorSha is an ancestor of (or equal to) descendantSha.
 */
function isAncestorOrEqual(dir: string, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const result = git(dir, 'merge-base', '--is-ancestor', ancestorSha, descendantSha);
  return result !== null;
}

/**
 * Returns true if the given SHA is a root commit (has no parents).
 */
function isRootCommit(dir: string, sha: string): boolean {
  const result = git(dir, 'rev-parse', '--verify', `${sha}^`);
  return result === null;
}

/**
 * Get commits in a range, returning {sha, authorDate} pairs.
 *
 * range semantics:
 *  - exclusive: commits strictly AFTER baseSha (base..head) — used for prior-VAL watermark
 *  - inclusive: commits AT AND AFTER baseSha — used when since= is explicitly passed
 *
 * For "inclusive" with a root commit: use empty-tree as the diff base.
 */
function getCommitsInRange(
  dir: string,
  baseSha: string,
  headSha: string,
  inclusive: boolean,
): Array<{ sha: string; authorDate: string; authorTimestampMs: number }> {
  // git log format: SHA tab AUTHOR_DATE (ISO 8601 with timezone: "2026-01-01 10:00:00 +0000")
  // Use %x09 (tab) as separator — safe on Windows
  const format = '%H%x09%ai';

  let rangeArg: string;
  if (inclusive) {
    // Include baseSha itself: use baseSha^..headSha, but fall back to EMPTY_TREE if root
    if (isRootCommit(dir, baseSha)) {
      rangeArg = `${EMPTY_TREE_SHA}..${headSha}`;
    } else {
      rangeArg = `${baseSha}^..${headSha}`;
    }
  } else {
    // Exclusive: baseSha..headSha (does not include baseSha)
    rangeArg = `${baseSha}..${headSha}`;
  }

  const out = git(dir, 'log', rangeArg, `--format=${format}`, '--no-merges');
  if (!out) return [];

  return out.split('\n')
    .filter(Boolean)
    .map(line => {
      const tabIdx = line.indexOf('\t');
      const sha = tabIdx > -1 ? line.slice(0, tabIdx) : line;
      // Author date: "2026-01-01 10:00:00 +0000"
      const fullDateStr = (tabIdx > -1 ? line.slice(tabIdx + 1) : '').trim();
      const dateStr = fullDateStr.slice(0, 10);
      // Parse ISO datetime to ms; normalize to a form Date.parse accepts reliably
      // "%ai" format: "2026-01-01 10:00:00 +0000" → replace space with 'T' and space before tz
      const normalized = fullDateStr.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /, '$1T$2');
      const timestampMs = Date.parse(normalized);
      return { sha, authorDate: dateStr, authorTimestampMs: isNaN(timestampMs) ? 0 : timestampMs };
    })
    .filter(c => c.sha.length === 40);
}

/**
 * Parse git --numstat output into {added, removed, file} records.
 * Skips binary files (shown as '-\t-\tfile').
 */
function parseNumstat(raw: string): Array<{ added: number; removed: number; file: string }> {
  return raw.split('\n')
    .filter(Boolean)
    .flatMap(line => {
      const parts = line.split('\t');
      if (parts.length < 3) return [];
      const added = parseInt(parts[0] ?? '0', 10);
      const removed = parseInt(parts[1] ?? '0', 10);
      const file = (parts[2] ?? '').trim();
      if (Number.isNaN(added) || Number.isNaN(removed) || !file) return [];
      return [{ added, removed, file }];
    });
}

/**
 * Endpoint diff: files and net LOC surviving at headSha (relative to baseSha).
 * For inclusive range with root commit, diff against empty tree.
 */
function getEndpointNumstat(
  dir: string,
  baseSha: string,
  headSha: string,
  inclusive: boolean,
): Array<{ added: number; removed: number; file: string }> {
  let diffBase: string;
  if (inclusive && isRootCommit(dir, baseSha)) {
    diffBase = EMPTY_TREE_SHA;
  } else if (inclusive) {
    // diff baseSha^ to headSha
    const parentSha = git(dir, 'rev-parse', `${baseSha}^`);
    diffBase = parentSha ?? EMPTY_TREE_SHA;
  } else {
    diffBase = baseSha;
  }

  const out = git(dir, 'diff', '--numstat', diffBase, headSha);
  if (!out) return [];
  return parseNumstat(out);
}

/**
 * Total additions across all commits in range (for churn calculation).
 */
function getTotalAdditionsInRange(
  dir: string,
  baseSha: string,
  headSha: string,
  inclusive: boolean,
): number {
  let rangeArg: string;
  if (inclusive) {
    if (isRootCommit(dir, baseSha)) {
      rangeArg = `${EMPTY_TREE_SHA}..${headSha}`;
    } else {
      rangeArg = `${baseSha}^..${headSha}`;
    }
  } else {
    rangeArg = `${baseSha}..${headSha}`;
  }

  // Use --numstat with empty format to get only numstat lines
  const out = git(dir, 'log', rangeArg, '--numstat', '--format=');
  if (!out) return 0;
  const lines = parseNumstat(out);
  return lines.reduce((sum, l) => sum + l.added, 0);
}

// ---------------------------------------------------------------------------
// Glob pattern matching
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (any path segments), * (single segment wildcard), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/');
  let regexStr = '^';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        // **/ → match zero or more path segments (including none)
        regexStr += '(?:[^/]+/)*';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some(p => globToRegex(p).test(normalized));
}

// ---------------------------------------------------------------------------
// Unit classification
// ---------------------------------------------------------------------------

/**
 * Classify a file as a unit class, or null if not classifiable.
 * Order: docs → modules → test (null) → scripts by extension
 */
function classifyUnit(filePath: string, config: ValueConfig): UnitClass | null {
  const normalized = filePath.replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  const basename = path.basename(normalized);
  const patterns = config.classification_patterns;

  // Doc class: markdown, rst, html
  if (matchesAnyGlob(normalized, patterns.doc_patterns)) {
    return 'docs';
  }

  // Module class: __init__.py, index.ts, index.js
  if (matchesAnyGlob(normalized, patterns.module_patterns)) {
    return 'modules';
  }

  // Test class: skip (provides evidence, not a unit)
  if (matchesAnyGlob(normalized, patterns.test_patterns)) {
    return null;
  }

  // Script/tool class: script extensions
  if (patterns.script_extensions.includes(ext)) {
    // Files in tools/ candidate location get the 'tools' class
    if (matchesAnyGlob(normalized, ['tools/**', 'bin/**'])) {
      return 'tools';
    }
    return 'scripts';
  }

  // Named pipeline files
  if (basename === 'Snakefile' || basename === 'nextflow.config') {
    return 'scripts';
  }

  return null;
}

function isTestFile(filePath: string, config: ValueConfig): boolean {
  return matchesAnyGlob(filePath.replace(/\\/g, '/'), config.classification_patterns.test_patterns);
}

function isCandidateLocation(filePath: string, config: ValueConfig): boolean {
  return matchesAnyGlob(filePath.replace(/\\/g, '/'), config.classification_patterns.candidate_locations);
}

// ---------------------------------------------------------------------------
// Frontmatter reader for prior VAL records (minimal, line-oriented)
// ---------------------------------------------------------------------------

function readValFrontmatter(absPath: string): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8').replace(/\r\n/g, '\n');
    if (!raw.startsWith('---')) return null;
    const endIdx = raw.indexOf('\n---', 3);
    if (endIdx === -1) return null;
    const block = raw.slice(4, endIdx);
    const result: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i);
      if (m) {
        result[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chain status and watermark resolution
// ---------------------------------------------------------------------------

interface PriorValInfo {
  id: string;
  headCommit: string;
}

/**
 * Scan wiki/value-reports/ for VAL records and find the most recent one
 * whose head_commit is an ancestor of (or equals) HEAD.
 */
function findPriorVal(dir: string, currentHead: string): PriorValInfo | null {
  const valDir = path.join(dir, 'wiki', 'value-reports');
  if (!fs.existsSync(valDir)) return null;

  const files = fs.readdirSync(valDir)
    .filter(f => f.endsWith('.md') && /^VAL-\d+\.md$/.test(f))
    .sort()
    .reverse(); // latest numeric ID first

  for (const file of files) {
    const fm = readValFrontmatter(path.join(valDir, file));
    if (!fm?.head_commit || !fm?.id) continue;
    if (isAncestorOrEqual(dir, fm.head_commit, currentHead)) {
      return { id: fm.id, headCommit: fm.head_commit };
    }
  }
  return null;
}

function computeChainStatus(
  dir: string,
  baseSha: string,
  priorVal: PriorValInfo | null,
): ChainStatus {
  if (!priorVal) return 'first';

  const priorHead = priorVal.headCommit;

  if (baseSha === priorHead) return 'complete';

  const baseIsAncOfPrior = isAncestorOrEqual(dir, baseSha, priorHead);
  const priorIsAncOfBase = isAncestorOrEqual(dir, priorHead, baseSha);

  if (baseIsAncOfPrior && !priorIsAncOfBase) return 'overlap';
  if (priorIsAncOfBase && !baseIsAncOfPrior) return 'gap';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

function inclusiveDaysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  const end = new Date(endDate + 'T00:00:00Z').getTime();
  const diffDays = Math.round((end - start) / 86_400_000);
  return Math.max(1, diffDays + 1);
}

/**
 * Anchor table's nominal work-day length (hours). Frozen constant — not operator-tunable.
 * Used for work_hours ↔ days conversion, keeping the work_hours-derived alternative
 * denominator unit-consistent with the human-day numerator (anchor table's day).
 */
const HOURS_PER_WORK_DAY = 8;

// COCOMO II.2000 post-architecture, NOMINAL. Boehm et al. 2000,
// "Software Cost Estimation with COCOMO II" (Prentice Hall).
// PM = A * KSLOC^E ; A = 2.94 ; E = B + 0.01*ΣSF, B = 0.91, nominal ΣSF = 18.97 => E = 1.0997 ;
// all 17 effort multipliers = 1.0 (nominal). Frozen — not operator-tunable.
const COCOMO_A = 2.94;
const COCOMO_E = 1.0997; // 0.91 + 0.01 * 18.97

/**
 * Compute COCOMO II nominal ceiling from code-only KSLOC.
 * Guard: cocomo_kloc === 0 → cocomo_pm_nominal = 0 (no NaN).
 * Display-only — never referenced by estimate arithmetic.
 */
function computeCocomo(codeOnlyNetLoc: number): { cocomo_kloc: number; cocomo_pm_nominal: number } {
  const cocomo_kloc = Math.round((codeOnlyNetLoc / 1000) * 1000) / 1000;
  if (cocomo_kloc === 0) {
    return { cocomo_kloc: 0, cocomo_pm_nominal: 0 };
  }
  const pm = COCOMO_A * Math.pow(cocomo_kloc, COCOMO_E);
  const cocomo_pm_nominal = Math.round(pm * 100) / 100;
  return { cocomo_kloc, cocomo_pm_nominal };
}

/**
 * Per-active-day floor for work_hours: applied when a day's intra-day span is below this
 * value (including single-commit days whose span = 0).
 */
const WORK_HOURS_DAY_FLOOR = 0.5;

/**
 * Compute git-derived work time from the in-span commit set.
 *
 * - work_days: count of distinct calendar dates (YYYY-MM-DD from git author date) carrying ≥1 commit.
 * - work_hours: Σ over each active day of (last − first author-timestamp that day, in hours),
 *   floored at WORK_HOURS_DAY_FLOOR per day (handles single-commit days whose span = 0).
 *
 * No clamping of work_days; falsifiability is the point.
 */
function computeWorkTime(
  commits: Array<{ authorDate: string; authorTimestampMs: number }>,
): { work_days: number; work_hours: number } {
  if (commits.length === 0) {
    return { work_days: 0, work_hours: 0 };
  }

  // Group commits by their calendar date (YYYY-MM-DD, git author date)
  const byDate = new Map<string, number[]>();
  for (const c of commits) {
    if (!c.authorDate) continue;
    const existing = byDate.get(c.authorDate);
    if (existing) {
      existing.push(c.authorTimestampMs);
    } else {
      byDate.set(c.authorDate, [c.authorTimestampMs]);
    }
  }

  const work_days = byDate.size;
  let work_hours = 0;

  for (const timestamps of byDate.values()) {
    const validTs = timestamps.filter(t => t > 0);
    if (validTs.length <= 1) {
      // Single commit (or no valid timestamps) → apply floor
      work_hours += WORK_HOURS_DAY_FLOOR;
    } else {
      const minTs = Math.min(...validTs);
      const maxTs = Math.max(...validTs);
      const spanHours = (maxTs - minTs) / 3_600_000;
      // Apply floor if span is below floor (e.g. two commits in the same second)
      work_hours += spanHours < WORK_HOURS_DAY_FLOOR ? WORK_HOURS_DAY_FLOOR : spanHours;
    }
  }

  return { work_days, work_hours };
}

// ---------------------------------------------------------------------------
// WK id gathering (commit message scan ∪ graph repo_path edges)
// ---------------------------------------------------------------------------

/**
 * Extract WK ids from commit messages in the given range.
 */
function gatherWkIdsFromCommits(dir: string, baseSha: string, headSha: string, inclusive: boolean): string[] {
  let rangeArg: string;
  if (inclusive) {
    if (isRootCommit(dir, baseSha)) {
      rangeArg = `${EMPTY_TREE_SHA}..${headSha}`;
    } else {
      rangeArg = `${baseSha}^..${headSha}`;
    }
  } else {
    rangeArg = `${baseSha}..${headSha}`;
  }
  const out = git(dir, 'log', rangeArg, '--format=%s %b');
  if (!out) return [];
  const matches = out.match(/(?:WK|PLN|IN|DEC|SRC|AREA|VAL)-\d{4}/g) ?? [];
  return [...new Set(matches)];
}

/**
 * Gather WK ids: commit-message regex ∪ graph-derived ids (wiki records with
 * repo_path edges to any file in the span-changed set).
 *
 * Per-unit wk_ids (the record ids whose repo_path edges point at that unit's file)
 * are built separately in the main function using repoPathEdges.
 */
function gatherWkIds(
  dir: string,
  baseSha: string,
  headSha: string,
  inclusive: boolean,
  spanFiles: Set<string>,
  repoPathEdges: Map<string, Set<string>>,
): string[] {
  const commitIds = gatherWkIdsFromCommits(dir, baseSha, headSha, inclusive);

  // Graph-derived: for each file in the span, find wiki records that link to it
  const graphIds: string[] = [];
  for (const filePath of spanFiles) {
    const recordPaths = repoPathEdges.get(filePath);
    if (!recordPaths) continue;
    for (const recordPath of recordPaths) {
      // Extract the id-like prefix from the filename: "wiki/issues/WK-0099.md" → "WK-0099"
      const basename = path.basename(recordPath, '.md');
      const m = basename.match(/^((?:WK|PLN|IN|DEC|SRC|AREA|VAL)-\d{4})$/);
      if (m) graphIds.push(m[1]);
    }
  }

  return [...new Set([...commitIds, ...graphIds])];
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig(dir: string, optsConfig?: Partial<ValueConfig>): ValueConfig {
  let merged: ValueConfig = { ...DEFAULT_CONFIG };

  const filePath = path.join(dir, 'wiki', '.value-config.json');
  if (fs.existsSync(filePath)) {
    try {
      const fileConf = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ValueConfig>;
      merged = deepMergeConfig(merged, fileConf);
    } catch {
      // Ignore malformed config
    }
  }

  if (optsConfig) {
    merged = deepMergeConfig(merged, optsConfig);
  }

  return merged;
}

function deepMergeConfig(base: ValueConfig, over: Partial<ValueConfig>): ValueConfig {
  const result: ValueConfig = { ...base };
  if (over.loc_per_day !== undefined) result.loc_per_day = over.loc_per_day;
  if (over.ccusage_version !== undefined) result.ccusage_version = over.ccusage_version;
  if (over.exclude_globs) result.exclude_globs = over.exclude_globs;
  if (over.classification_patterns) {
    result.classification_patterns = { ...base.classification_patterns, ...over.classification_patterns };
  }
  if (over.model_patterns !== undefined) result.model_patterns = over.model_patterns;
  return result;
}

// ---------------------------------------------------------------------------
// Graph loading
// ---------------------------------------------------------------------------

function loadGraph(dir: string): GraphExport | null {
  const graphPath = path.join(dir, 'wiki', '.graph.json');
  if (!fs.existsSync(graphPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as GraphExport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Compute deterministic, offline value-report metrics for a git repo.
 * Tool measures facts only — estimation arithmetic lives in the template/agent layer.
 */
export async function computeValueReport(opts: ValueReportOpts): Promise<Result<ValueMetrics>> {
  const dir = path.resolve(opts.dir);

  if (!isGitRepo(dir)) {
    return fail('GIT_UNAVAILABLE', `Not a git repository: ${dir}`);
  }

  const headSha = resolveHead(dir);
  if (!headSha) {
    return fail('GIT_UNAVAILABLE', `Could not resolve HEAD in: ${dir}`);
  }

  const config = loadConfig(dir, opts.config);

  // Resolve head ref
  const resolvedHead = opts.untilRef
    ? (git(dir, 'rev-parse', opts.untilRef) ?? headSha)
    : headSha;

  // Resolve base commit and determine if it's "inclusive" (since= explicitly provided)
  let baseSha: string;
  let inclusive: boolean; // true = include baseSha commit itself in the range
  let priorValInfo: PriorValInfo | null = null;

  if (opts.since) {
    // Caller explicitly says "start from this commit" — inclusive
    baseSha = git(dir, 'rev-parse', opts.since) ?? opts.since;
    inclusive = true;
    // Still scan for prior VAL for chain status
    priorValInfo = findPriorVal(dir, resolvedHead);
  } else {
    // Auto-detect from prior VAL
    priorValInfo = findPriorVal(dir, resolvedHead);
    if (priorValInfo) {
      baseSha = priorValInfo.headCommit;
      inclusive = false; // commits AFTER prior head (exclusive)
    } else {
      // First run: include from the very first commit
      const first = resolveFirstCommit(dir);
      if (!first) {
        return fail('GIT_UNAVAILABLE', 'Could not resolve first commit');
      }
      baseSha = first;
      inclusive = true;
    }
  }

  // Commits in range
  const commits = getCommitsInRange(dir, baseSha, resolvedHead, inclusive);
  const commitCount = commits.length;

  // Chain status
  const chainStatus = computeChainStatus(dir, baseSha, priorValInfo);
  const priorVal = priorValInfo?.id ?? 'none';

  // Endpoint diff (net LOC per surviving file)
  const endpointNumstat = getEndpointNumstat(dir, baseSha, resolvedHead, inclusive);

  // Total additions across all commits (for churn)
  const totalAdditions = getTotalAdditionsInRange(dir, baseSha, resolvedHead, inclusive);

  // Separate included vs excluded files
  const includedFiles: Array<{ added: number; removed: number; file: string }> = [];
  const excludedFiles: Array<{ added: number; removed: number; file: string }> = [];
  for (const line of endpointNumstat) {
    if (matchesAnyGlob(line.file, config.exclude_globs)) {
      excludedFiles.push(line);
    } else {
      includedFiles.push(line);
    }
  }

  const netLocAdded = includedFiles.reduce((s, l) => s + l.added, 0);
  const netLocRemoved = includedFiles.reduce((s, l) => s + l.removed, 0);
  const excludedFilesCount = excludedFiles.length;
  const excludedLocCount = excludedFiles.reduce((s, l) => s + l.added, 0);

  // Churn = total additions (included files only) − net endpoint additions
  const excludedTotalAdds = excludedFiles.reduce((s, l) => s + l.added, 0);
  const includedTotalAdds = Math.max(0, totalAdditions - excludedTotalAdds);
  const churnLoc = Math.max(0, includedTotalAdds - netLocAdded);

  // Span days (max 1, spec §9) — calendar span; secondary context field
  let spanDays = 1;
  if (commits.length >= 2) {
    const dates = commits.map(c => c.authorDate).filter(Boolean).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (first && last) {
      spanDays = inclusiveDaysBetween(first, last);
    }
  }

  // Git-derived work time (WK-0040): work_days / work_hours / hours_per_work_day
  // Computed over the SAME in-span commit set (commits array). No re-derivation of watermark.
  const { work_days, work_hours } = computeWorkTime(commits);

  // Window dates
  let windowStart = '';
  let windowEnd = '';
  if (commits.length > 0) {
    const dates = commits.map(c => c.authorDate).filter(Boolean).sort();
    windowStart = dates[0] ?? '';
    windowEnd = dates[dates.length - 1] ?? '';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    windowStart = today;
    windowEnd = today;
  }

  // Load graph (single load; both edge maps share this)
  const graph = loadGraph(dir);
  const graphAvailable = graph !== null;

  // Build imports edge maps
  const inboundEdges = new Map<string, Set<string>>(); // target → set of sources (imports relation)
  const outboundEdges = new Map<string, Set<string>>(); // source → set of targets (imports relation)

  // Build repo_path edge map: filePath → Set of wiki record paths (source = wiki record, target = file path)
  const repoPathEdges = new Map<string, Set<string>>(); // filePath → Set<wikiRecordPath>

  if (graph) {
    for (const edge of graph.edges) {
      if (edge.relation === 'imports') {
        if (!inboundEdges.has(edge.target)) inboundEdges.set(edge.target, new Set());
        inboundEdges.get(edge.target)!.add(edge.source);
        if (!outboundEdges.has(edge.source)) outboundEdges.set(edge.source, new Set());
        outboundEdges.get(edge.source)!.add(edge.target);
      } else if (edge.relation === 'repo_path') {
        // source = wiki record id (e.g. "wiki/issues/WK-0039.md")
        // target = file path (e.g. "packages/wiki-core/src/value-report.ts")
        if (!repoPathEdges.has(edge.target)) repoPathEdges.set(edge.target, new Set());
        repoPathEdges.get(edge.target)!.add(edge.source);
      }
    }
  }

  // Surviving files set and per-file LOC map
  const survivingFiles = new Set(includedFiles.map(f => f.file));
  const fileNetLoc = new Map<string, number>();
  for (const f of includedFiles) {
    fileNetLoc.set(f.file, f.added);
  }

  // Identify test files
  const testFileSet = new Set<string>();
  for (const fp of survivingFiles) {
    if (isTestFile(fp, config)) testFileSet.add(fp);
  }

  // Classify units and assign evidence (tested > wired > linked > candidate > survives)
  const unitCounts: Record<UnitClass, UnitClassCounts> = {
    scripts: { survives: 0, wired: 0, tested: 0 },
    modules: { survives: 0, wired: 0, tested: 0 },
    tools: { survives: 0, wired: 0, tested: 0 },
    docs: { survives: 0, wired: 0, tested: 0 },
  };

  const unitDetails: ValueUnitDetail[] = [];
  const candidates: ValueCandidate[] = [];

  for (const fp of survivingFiles) {
    if (testFileSet.has(fp)) continue;

    const unitClass = classifyUnit(fp, config);
    if (!unitClass) continue;

    const netLoc = fileNetLoc.get(fp) ?? 0;
    let evidence: ValueUnitDetail['evidence'] = 'survives';

    if (graphAvailable) {
      const inboundSources = [...(inboundEdges.get(fp) ?? new Set<string>())];
      const outboundTargets = outboundEdges.get(fp) ?? new Set<string>();

      // Tested: a surviving test file imports fp (test-sourced inbound edge)
      const importedByTest = inboundSources.some(src => testFileSet.has(src));

      // Wired: inbound from non-test files, OR outbound to other surviving repo files
      const hasNonTestInbound = inboundSources.some(src => !testFileSet.has(src));
      const hasOutboundToRepo = [...outboundTargets].some(t => survivingFiles.has(t));

      // Linked: a wiki record has a repo_path edge pointing at this file, but no import evidence
      const hasRepoPathEdge = repoPathEdges.has(fp);

      if (importedByTest) {
        // Tested takes priority — most specific evidence
        evidence = 'tested';
      } else if (hasNonTestInbound || hasOutboundToRepo) {
        evidence = 'wired';
      } else if (hasRepoPathEdge) {
        // Linked: wiki-tracked but not import-connected (e.g. entrypoint scripts)
        evidence = 'linked';
      } else if (isCandidateLocation(fp, config)) {
        evidence = 'candidate';
      }
    } else {
      // No graph available: no linked tier possible
      if (isCandidateLocation(fp, config)) {
        evidence = 'candidate';
      }
    }

    unitDetails.push({ path: fp, unitClass, evidence, netLoc });
    unitCounts[unitClass].survives++;
    if (evidence === 'wired') unitCounts[unitClass].wired++;
    if (evidence === 'tested') unitCounts[unitClass].tested++;

    if (evidence === 'candidate') {
      const matchedPattern = config.classification_patterns.candidate_locations.find(
        p => globToRegex(p).test(fp.replace(/\\/g, '/')),
      );
      candidates.push({
        path: fp,
        unitClass,
        reason: matchedPattern ?? 'candidate-location',
      });
    }
  }

  // COCOMO II nominal ceiling (WK-0041): code-only net LOC = classifier-recognized code units
  // (unitClass scripts/modules/tools, NOT docs) + test files. Config, data, and unclassified text
  // are NOT SLOC (COCOMO II / SEI counting checklist: source statements only; data & docs excluded).
  // unitDetails already excludes docs, test files, and unclassified files (classifyUnit -> null ->
  // skipped), so filtering it to non-docs is exactly the code-unit surface; test-file LOC is added
  // back from testFileSet via fileNetLoc. Positive definition via classification patterns, not an
  // extension blocklist (CWL is YAML -> a blocklist would drop real workflow code). Residual error
  // direction is undercount (a DSL missing from patterns shrinks the ceiling) -- conservative.
  const codeUnitNetLoc = unitDetails
    .filter(d => d.unitClass !== 'docs')
    .reduce((sum, d) => sum + d.netLoc, 0);
  const testNetLoc = [...testFileSet].reduce((sum, fp) => sum + (fileNetLoc.get(fp) ?? 0), 0);
  const codeOnlyNetLoc = codeUnitNetLoc + testNetLoc;
  const { cocomo_kloc, cocomo_pm_nominal } = computeCocomo(codeOnlyNetLoc);

  // Reverted commits
  const revertedCommits = commits.filter(c => {
    const msg = git(dir, 'log', '-1', '--format=%s', c.sha) ?? '';
    return /^revert\b/i.test(msg);
  }).length;

  // WK ids: commit-message regex ∪ graph repo_path edges to span files
  const wkIds = gatherWkIds(dir, baseSha, resolvedHead, inclusive, survivingFiles, repoPathEdges);

  // Tests added = test files in surviving set
  const testsAdded = [...survivingFiles].filter(f => testFileSet.has(f)).length;
  const filesChanged = includedFiles.length;

  // Build review_units[]: tested/wired/linked/candidate tiers; exclude pure-survives and test files
  const reviewUnits: ValueReviewUnit[] = [];
  for (const detail of unitDetails) {
    if (detail.evidence === 'survives') continue; // pure-survives excluded

    // Per-unit wk_ids: wiki record ids whose repo_path edges point at this file
    const unitWkIds: string[] = [];
    const recordPaths = repoPathEdges.get(detail.path);
    if (recordPaths) {
      for (const recordPath of recordPaths) {
        const basename = path.basename(recordPath, '.md');
        const m = basename.match(/^((?:WK|PLN|IN|DEC|SRC|AREA|VAL)-\d{4})$/);
        if (m) unitWkIds.push(m[1]);
      }
    }

    reviewUnits.push({
      path: detail.path,
      unitClass: detail.unitClass,
      tier: detail.evidence,
      wk_ids: unitWkIds,
      net_loc: detail.netLoc,
      loc_reference: detail.netLoc / config.loc_per_day,
    });
  }

  return ok({
    window_start: windowStart,
    window_end: windowEnd,
    base_commit: baseSha,
    head_commit: resolvedHead,
    prior_val: priorVal,
    chain_status: chainStatus,
    span_days: spanDays,
    work_days,
    work_hours,
    hours_per_work_day: HOURS_PER_WORK_DAY,
    cocomo_kloc,
    cocomo_pm_nominal,
    commits: commitCount,
    files_changed: filesChanged,
    net_loc_added: netLocAdded,
    net_loc_removed: netLocRemoved,
    tests_added: testsAdded,
    units: unitCounts,
    units_candidates: candidates.length,
    churn_loc: churnLoc,
    excluded_files: excludedFilesCount,
    excluded_loc: excludedLocCount,
    reverted_commits: revertedCommits,
    wk_created: 0,
    wk_closed: 0,
    wk_ids: wkIds,
    graph_available: graphAvailable,
    loc_per_day: config.loc_per_day,
    review_units: reviewUnits,
    candidates,
    unit_details: unitDetails,
  });
}
