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
import { createHash } from 'node:crypto';
import { ok, fail, type Result } from './errors.js';
import type {
  ValueReportOpts,
  ValueMetrics,
  ValueConfig,
  ValueCandidate,
  ValueUnitDetail,
  ValueReviewUnit,
  ValueDataTrace,
  CodeUnitClass,
  DataUnitClass,
  RateFlag,
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
  // Corpus-wide throughput rate — the per-unit estimator proposal AND tripwire (DEC-0003).
  // calibrated from SRC-0002, 661 included units, git-dated 2022-12-01→2026-06-24, poll 2026-07-29
  // = 129,447 net LOC ÷ 498 distinct operator active-days = 259.9 → 260. Cross-validated
  // leave-one-section-out to within 2× (median 0.92), conservative-biased. Drives loc_reference;
  // proposed_days per review unit = loc_reference. Estimate arithmetic stays in the
  // template/agent layer — the tool only measures.
  loc_per_day: 260,
  ccusage_version: '20.0.17',
  exclude_globs: [
    'scratch_space/**',
    'experiments/**',
    'sandbox/**',
    '**/*_adhoc*',
    '**/pilot_*',
    // Generated artifacts (WK-0053: a 35.6k-LOC generated graph-summary.md polluted net LOC)
    '**/graph-summary.md',
    'wiki/catalog.md',
    'wiki/now.md',
    'wiki/inbox.md',
    'wiki/backlog.md',
    'wiki/archive.md',
    'wiki/generated/**',
    'wiki/.graph.json',
    'wiki/.search-index.json',
  ],
  classification_patterns: {
    script_extensions: [
      '.py', '.R', '.r', '.Rmd', '.qmd', '.ipynb',
      '.sh', '.bash', '.zsh', '.ksh', '.pl',
      // JS/TS module family + TS/JSX variants (WK-0056 Rung 4: a .mjs entrypoint surfaced as an
      // unclassified candidate — these are universally code). .ksh added for parity with the
      // shell-wrapper rate_flag set (computeRateFlag SHELL_EXTS).
      '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.java', '.sql',
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
    // Real test-CODE filename patterns only (WK-0059). The blanket '**/tests/**' was removed:
    // it nulled fixture generators and shipped code under tests/. Test code now classifies as a
    // code unit AND still marks its target 'tested' + counts in tests_added (isTestFile).
    test_patterns: [
      '**/test_*.py',
      '**/*_test.py',
      '**/*_test.go',
      '**/*.test.*',
      '**/*.spec.*',
      '**/testthat/**',
      '**/test-*.R',
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
    // Data-asset extensions (WK-0059): detection/traceability only, priced 0. Positive list —
    // unknown extensions become `unclassified` candidates (operator ratifies), never silent null.
    // Deliberately excludes code-as-data-syntax types (.cwl/.nf/.smk/.wdl stay in script_extensions).
    // Dual-use structured formats (.json/.xml — package.json, tsconfig.json, etc.) are intentionally
    // classified data (priced 0, per the spec's example list) rather than flooding the operator gate
    // with an unclassified ruling for every config file; an operator who ships data JSON can still
    // rule specific globs orphan_data. NOTE: like the other classification_patterns sub-keys (and
    // unlike exclude_globs), config REPLACES this list — but a dropped default surfaces as an
    // `unclassified` candidate, not a silent drop, so the no-silent-drop guarantee still holds.
    data_extensions: [
      '.csv', '.tsv', '.psv', '.parquet', '.feather', '.arrow', '.orc',
      '.json', '.jsonl', '.ndjson', '.xml',
      '.h5', '.h5ad', '.hdf5', '.loom', '.zarr', '.mtx',
      '.rds', '.rda', '.rdata',
      '.npy', '.npz', '.pkl', '.pickle', '.joblib', '.mat', '.nc',
      '.xlsx', '.xls', '.ods',
      '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zip', '.7z',
      '.vcf', '.bam', '.sam', '.cram', '.bed', '.gff', '.gff3', '.gtf',
      '.fasta', '.fa', '.fastq', '.fq', '.fai', '.bai',
      '.db', '.sqlite', '.duckdb',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.tiff',
    ],
  },
  // Extensionless-executable path overrides + orphan-data operator rulings default empty (WK-0059).
  script_path_overrides: [],
  orphan_data_globs: [],
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
 * All files surviving at headSha (relative to baseSha), INCLUDING binary assets that
 * `--numstat` drops (WK-0059 no-silent-drop). Deleted paths are excluded (not surviving);
 * rename/copy targets use the new path. Mirrors getEndpointNumstat's diff-base resolution.
 */
function getEndpointFileList(
  dir: string,
  baseSha: string,
  headSha: string,
  inclusive: boolean,
): string[] {
  let diffBase: string;
  if (inclusive && isRootCommit(dir, baseSha)) {
    diffBase = EMPTY_TREE_SHA;
  } else if (inclusive) {
    const parentSha = git(dir, 'rev-parse', `${baseSha}^`);
    diffBase = parentSha ?? EMPTY_TREE_SHA;
  } else {
    diffBase = baseSha;
  }

  const out = git(dir, 'diff', '--name-status', diffBase, headSha);
  if (!out) return [];
  const files: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('D')) continue; // deleted → not surviving
    // Rename (Rxxx) / copy (Cxxx): the new path is the last field; otherwise it's field 1.
    const p = status.startsWith('R') || status.startsWith('C') ? parts[parts.length - 1] : parts[1];
    if (p) files.push(p.trim());
  }
  return files;
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
 * The classification of a committed/linked file (WK-0059). Every file resolves to exactly one
 * of these — the tool NEVER silently drops a file to `null`:
 *  - `unit`         → a code/doc floor unit (enters the evidence ladder + unit_details)
 *  - `data`         → a data asset, priced 0 (enters data_traces)
 *  - `unclassified` → an unknown type surfaced for operator ratification (enters candidates)
 */
type FileClassification =
  | { kind: 'unit'; unitClass: CodeUnitClass }
  | { kind: 'data'; unitClass: DataUnitClass; reason: string }
  | { kind: 'unclassified'; reason: string };

/** True if the file's committed content starts with a `#!` shebang (portable exec signal). */
function hasShebang(dir: string, sha: string, filePath: string): boolean {
  const out = git(dir, 'show', `${sha}:${filePath}`);
  return out !== null && out.startsWith('#!');
}

/**
 * Classify a file. Precedence (WK-0059):
 *   docs → modules → explicit script override → known code extension → named pipeline file →
 *   data extension → extensionless-with-shebang → unclassified.
 * Extensionless-executable detection follows override → shebang → (candidate-location handled by
 * the caller's evidence ladder). A shebang-less extensionless blob stays `unclassified` — never
 * auto-swept as a script.
 */
function classifyFile(filePath: string, config: ValueConfig, shebang: boolean): FileClassification {
  const normalized = filePath.replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  const basename = path.basename(normalized);
  const patterns = config.classification_patterns;
  const codeClass = (): CodeUnitClass =>
    matchesAnyGlob(normalized, ['tools/**', 'bin/**']) ? 'tools' : 'scripts';

  // Docs first — precedes tests so markdown under tests/ stays docs (WK-0052 owns its pricing).
  if (matchesAnyGlob(normalized, patterns.doc_patterns)) return { kind: 'unit', unitClass: 'docs' };

  // Module entrypoints (__init__.py, index.ts, config-mapped library modules).
  if (matchesAnyGlob(normalized, patterns.module_patterns)) return { kind: 'unit', unitClass: 'modules' };

  // Explicit path/glob override — highest-precedence extensionless tier; also forces odd names.
  if (config.script_path_overrides && matchesAnyGlob(normalized, config.script_path_overrides)) {
    return { kind: 'unit', unitClass: codeClass() };
  }

  // Known code extension — includes test code (.py/.ts/.R…) and workflow DSLs (.cwl/.nf/.smk/.wdl).
  if (ext && patterns.script_extensions.includes(ext)) return { kind: 'unit', unitClass: codeClass() };

  // Named pipeline files.
  if (basename === 'Snakefile' || basename === 'nextflow.config') return { kind: 'unit', unitClass: 'scripts' };

  // Data assets — detection/traceability only, priced 0. `orphan_data_globs` is an operator ruling
  // (curated data, no in-repo generator); the tool never infers fixture↔generator ownership.
  if (ext && patterns.data_extensions.includes(ext)) {
    const isOrphan = !!config.orphan_data_globs && matchesAnyGlob(normalized, config.orphan_data_globs);
    return { kind: 'data', unitClass: isOrphan ? 'orphan_data' : 'data', reason: `data-extension:${ext}` };
  }

  // Extensionless executable, evidenced by a shebang.
  if (ext === '' && shebang) return { kind: 'unit', unitClass: codeClass() };

  // Unknown → operator ratifies (never a silent null).
  return { kind: 'unclassified', reason: ext ? `unknown-extension:${ext}` : 'extensionless-no-shebang' };
}

/**
 * Rate-applicability narration flag (WK-0059) for a code unit, or null when the SRC-0002 260
 * rate applies cleanly. Narration only — never changes arithmetic.
 */
const WORKFLOW_DSL_EXTS = new Set(['.cwl', '.nf', '.smk', '.wdl']);
const SHELL_EXTS = new Set(['.sh', '.bash', '.zsh', '.ksh']);
function computeRateFlag(filePath: string, isTest: boolean): RateFlag | null {
  const normalized = filePath.replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  const basename = path.basename(normalized);
  if (isTest) return 'test-code';
  if (WORKFLOW_DSL_EXTS.has(ext) || basename === 'Snakefile' || basename === 'nextflow.config') return 'workflow-dsl';
  if (SHELL_EXTS.has(ext)) return 'shell-wrapper';
  if (matchesAnyGlob(normalized, ['**/tests/**', '**/fixtures/**'])) return 'fixture-generator';
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

function loadConfig(
  dir: string,
  optsConfig?: Partial<ValueConfig>,
  frozenConfig?: ValueConfig,
): ValueConfig {
  // Freeze (WK-0059): a published VAL's resolved config is used verbatim — file + defaults are
  // bypassed — so re-render reproduces the figures regardless of later `.value-config.json` edits.
  if (frozenConfig) return frozenConfig;

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
  // Excludes are ADD-ONLY (WK-0059): union with the frozen defaults so local config can add
  // excludes but can never negate the WK-0055 generated-file excludes (test-enforced).
  if (over.exclude_globs) {
    result.exclude_globs = [...new Set([...base.exclude_globs, ...over.exclude_globs])];
  }
  if (over.classification_patterns) {
    result.classification_patterns = { ...base.classification_patterns, ...over.classification_patterns };
  }
  if (over.script_path_overrides !== undefined) result.script_path_overrides = over.script_path_overrides;
  if (over.orphan_data_globs !== undefined) result.orphan_data_globs = over.orphan_data_globs;
  if (over.model_patterns !== undefined) result.model_patterns = over.model_patterns;
  return result;
}

/**
 * Canonical JSON with recursively sorted object keys — so the serialization (and any hash of it)
 * is invariant to property order (e.g. a config that round-tripped through a published VAL).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable fingerprint of a resolved config (WK-0059). Recorded alongside a published VAL as its
 * config provenance; invariant to key order so a frozen round-tripped config hashes identically.
 */
function hashConfig(config: ValueConfig): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(config))).digest('hex').slice(0, 16);
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

  const config = loadConfig(dir, opts.config, opts.frozenConfig);

  // Resolve head ref — fail loud on an unresolvable ref (WK-0053: the silent fallback to
  // HEAD produced a wrong-span report)
  let resolvedHead = headSha;
  if (opts.untilRef) {
    const untilSha = git(dir, 'rev-parse', opts.untilRef);
    if (!untilSha) {
      return fail('GIT_UNAVAILABLE', `untilRef did not resolve: ${opts.untilRef}`);
    }
    resolvedHead = untilSha;
  }

  // Resolve base commit and determine if it's "inclusive" (since= explicitly provided)
  let baseSha: string;
  let inclusive: boolean; // true = include baseSha commit itself in the range
  let priorValInfo: PriorValInfo | null = null;

  if (opts.since) {
    // Caller explicitly says "start from this commit" — inclusive.
    // Fail loud on an unresolvable ref (WK-0053: the silent fallback to the raw string
    // produced a wrong-span report).
    const sinceSha = git(dir, 'rev-parse', opts.since);
    if (!sinceSha) {
      return fail('GIT_UNAVAILABLE', `since did not resolve: ${opts.since}`);
    }
    baseSha = sinceSha;
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

  // Full surviving-file list (WK-0059) — includes binary data assets that numstat drops. This is
  // the no-silent-drop classification universe; numstat still supplies net LOC for text files.
  const endpointFileList = getEndpointFileList(dir, baseSha, resolvedHead, inclusive);

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

  // Per-file net LOC (numstat text; binary/absent → 0). Classification universe = the full
  // surviving-file list minus excluded globs, unioned with the (already non-excluded) numstat
  // text files — so binary data assets are classified but no text file is ever missed (WK-0059).
  const fileNetLoc = new Map<string, number>();
  for (const f of includedFiles) {
    fileNetLoc.set(f.file, f.added);
  }
  const survivingFiles = new Set<string>([
    ...includedFiles.map(f => f.file),
    ...endpointFileList.filter(f => !matchesAnyGlob(f, config.exclude_globs)),
  ]);

  // Identify test files
  const testFileSet = new Set<string>();
  for (const fp of survivingFiles) {
    if (isTestFile(fp, config)) testFileSet.add(fp);
  }

  // Classify units and assign evidence (tested > wired > linked > candidate > survives)
  const unitCounts: Record<CodeUnitClass, UnitClassCounts> = {
    scripts: { survives: 0, wired: 0, tested: 0 },
    modules: { survives: 0, wired: 0, tested: 0 },
    tools: { survives: 0, wired: 0, tested: 0 },
    docs: { survives: 0, wired: 0, tested: 0 },
  };

  const unitDetails: ValueUnitDetail[] = [];
  const candidates: ValueCandidate[] = [];
  const dataTraces: ValueDataTrace[] = [];

  for (const fp of survivingFiles) {
    const ext = path.extname(fp).toLowerCase();
    // Shebang read is bounded to extensionless files (rare); the reliable exec signal on
    // git-for-Windows, where the exec bit is not preserved (WK-0059 precedence note).
    const shebang = ext === '' ? hasShebang(dir, resolvedHead, fp) : false;
    const cls = classifyFile(fp, config, shebang);

    // Data assets — priced 0, detection/traceability only. Never a review (estimate) unit.
    if (cls.kind === 'data') {
      dataTraces.push({ path: fp, unitClass: cls.unitClass, net_loc: fileNetLoc.get(fp) ?? 0, reason: cls.reason });
      continue;
    }
    // Unknown types — surfaced for operator ratification (the no-silent-drop spine). Valued 0.
    if (cls.kind === 'unclassified') {
      candidates.push({ path: fp, unitClass: 'unclassified', reason: cls.reason });
      continue;
    }

    // Code/doc floor unit — evidence ladder. Test code is NO LONGER skipped: it is its own floor
    // unit AND still marks its target 'tested' (testFileSet, below) with no numeric double-count.
    const unitClass = cls.unitClass;
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
  // (unitClass scripts/modules/tools, NOT docs). Data assets and unclassified files are NOT SLOC
  // (COCOMO II / SEI counting checklist: source statements only; data & docs excluded). Positive
  // definition via classification patterns, not an extension blocklist (CWL is YAML -> a blocklist
  // would drop real workflow code); a DSL missing from patterns shrinks the ceiling -- conservative.
  // Since WK-0059, test code is a first-class unit in unitDetails, so it is captured here directly;
  // the old `+ testNetLoc` add-back is gone (it would double-count now that test code is a unit).
  const codeOnlyNetLoc = unitDetails
    .filter(d => d.unitClass !== 'docs')
    .reduce((sum, d) => sum + d.netLoc, 0);
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

  // Build review_units[]: tested/wired/linked/candidate tiers; exclude pure-survives only.
  // Test code IS a review unit since WK-0059 (the test-file skip was removed) — it is both its
  // own floor unit and still marks its target 'tested'.
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
      rate_flag: computeRateFlag(detail.path, testFileSet.has(detail.path)),
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
    data_traces: dataTraces,
    candidates,
    unit_details: unitDetails,
    resolved_config: config,
    config_hash: hashConfig(config),
  });
}
