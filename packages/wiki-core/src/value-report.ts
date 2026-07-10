/**
 * Value-report module — deterministic, offline half of the VAL agent-value report.
 *
 * Reads git history + wiki/.graph.json and computes:
 * - Commit-watermark scope and chain status
 * - Unit classification with evidence ladder (wired / tested / candidate / survives)
 * - Churn calculation
 * - Conservative human-time estimate anchors
 *
 * Public API: computeValueReport(opts) → Result<ValueMetrics>
 *
 * Rules:
 * - Result<T> everywhere; never throw
 * - Offline only: node:child_process git + node:fs (no network)
 * - NEVER import graph-explore (cross-subsystem import is forbidden)
 * - Use execFileSync with arg arrays to avoid Windows shell pipe-parsing issues
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
// Config defaults (spec §9)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ValueConfig = {
  per_unit_days: { scripts: 0.25, modules: 2, tools: 3, docs: 0.25 },
  loc_per_day: 150,
  speedup_cap: 10,
  ccusage_version: '0.8.0',
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
): Array<{ sha: string; authorDate: string }> {
  // git log format: SHA tab AUTHOR_DATE
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
      // Author date: "2026-01-01 10:00:00 +0000" → take first 10 chars
      const dateStr = (tabIdx > -1 ? line.slice(tabIdx + 1) : '').trim().slice(0, 10);
      return { sha, authorDate: dateStr };
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

// ---------------------------------------------------------------------------
// WK id gathering (commit message scan)
// ---------------------------------------------------------------------------

function gatherWkIds(dir: string, baseSha: string, headSha: string, inclusive: boolean): string[] {
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
  const matches = out.match(/WK-\d{4}/g) ?? [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig(dir: string, optsConfig?: Partial<ValueConfig>): ValueConfig {
  let merged: ValueConfig = { ...DEFAULT_CONFIG, per_unit_days: { ...DEFAULT_CONFIG.per_unit_days } };

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
  const result: ValueConfig = { ...base, per_unit_days: { ...base.per_unit_days } };
  if (over.per_unit_days) result.per_unit_days = { ...base.per_unit_days, ...over.per_unit_days };
  if (over.loc_per_day !== undefined) result.loc_per_day = over.loc_per_day;
  if (over.speedup_cap !== undefined) result.speedup_cap = over.speedup_cap;
  if (over.ccusage_version !== undefined) result.ccusage_version = over.ccusage_version;
  if (over.exclude_globs) result.exclude_globs = over.exclude_globs;
  if (over.classification_patterns) {
    result.classification_patterns = { ...base.classification_patterns, ...over.classification_patterns };
  }
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

  // Span days (max 1, spec §9)
  let spanDays = 1;
  if (commits.length >= 2) {
    const dates = commits.map(c => c.authorDate).filter(Boolean).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (first && last) {
      spanDays = inclusiveDaysBetween(first, last);
    }
  }

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

  // Load graph
  const graph = loadGraph(dir);
  const graphAvailable = graph !== null;

  // Build edge lookup maps (imports only)
  const inboundEdges = new Map<string, Set<string>>(); // target → set of sources
  const outboundEdges = new Map<string, Set<string>>(); // source → set of targets

  if (graph) {
    for (const edge of graph.edges) {
      if (edge.relation !== 'imports') continue;
      if (!inboundEdges.has(edge.target)) inboundEdges.set(edge.target, new Set());
      inboundEdges.get(edge.target)!.add(edge.source);
      if (!outboundEdges.has(edge.source)) outboundEdges.set(edge.source, new Set());
      outboundEdges.get(edge.source)!.add(edge.target);
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

  // Classify units and assign evidence
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

      if (importedByTest) {
        // Tested takes priority — it's more specific evidence than generic wired
        evidence = 'tested';
      } else if (hasNonTestInbound || hasOutboundToRepo) {
        evidence = 'wired';
      } else if (isCandidateLocation(fp, config)) {
        evidence = 'candidate';
      }
    } else {
      // No graph available
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

  // units_valued = wired ∪ tested (attested added by operator later — NOT here)
  const valuedUnits = unitDetails.filter(u => u.evidence === 'wired' || u.evidence === 'tested');
  const unitsValued = valuedUnits.length;

  // Estimate arithmetic (spec §9)
  const humanDaysUnits = valuedUnits.reduce((sum, u) => {
    const classConst = config.per_unit_days[u.unitClass];
    const locValue = u.netLoc / config.loc_per_day;
    return sum + Math.min(classConst, locValue);
  }, 0);

  const humanDaysLoc = netLocAdded / config.loc_per_day;
  const humanDaysAnchor = Math.min(humanDaysUnits, humanDaysLoc);
  const timeSavedDays = humanDaysAnchor - spanDays; // NO clamp
  const speedup = Math.min(humanDaysAnchor / spanDays, config.speedup_cap); // may be < 1

  // Estimate basis string
  const graphNote = graphAvailable ? 'graph fresh' : 'graph absent (wired/tested skipped)';
  const unitSummary = valuedUnits.length > 0
    ? valuedUnits.map(u => `${u.unitClass}(${u.evidence})`).join(', ')
    : 'no valued units';
  const estimateBasis = [
    `units: ${unitSummary}`,
    `loc floor ${netLocAdded}/${config.loc_per_day}`,
    `anchor=${humanDaysAnchor.toFixed(3)}`,
    `cap ${config.speedup_cap}`,
    graphNote,
    `chain ${chainStatus}`,
  ].join('; ');

  // Reverted commits
  const revertedCommits = commits.filter(c => {
    const msg = git(dir, 'log', '-1', '--format=%s', c.sha) ?? '';
    return /^revert\b/i.test(msg);
  }).length;

  // WK ids from commit messages
  const wkIds = gatherWkIds(dir, baseSha, resolvedHead, inclusive);

  // Tests added = test files in surviving set
  const testsAdded = [...survivingFiles].filter(f => testFileSet.has(f)).length;
  const filesChanged = includedFiles.length;

  return ok({
    window_start: windowStart,
    window_end: windowEnd,
    base_commit: baseSha,
    head_commit: resolvedHead,
    prior_val: priorVal,
    chain_status: chainStatus,
    span_days: spanDays,
    commits: commitCount,
    files_changed: filesChanged,
    net_loc_added: netLocAdded,
    net_loc_removed: netLocRemoved,
    tests_added: testsAdded,
    units: unitCounts,
    units_candidates: candidates.length,
    units_valued: unitsValued,
    churn_loc: churnLoc,
    excluded_files: excludedFilesCount,
    excluded_loc: excludedLocCount,
    reverted_commits: revertedCommits,
    wk_created: 0,
    wk_closed: 0,
    wk_ids: wkIds,
    graph_available: graphAvailable,
    human_days_units: humanDaysUnits,
    human_days_loc: humanDaysLoc,
    human_days_anchor: humanDaysAnchor,
    time_saved_days: timeSavedDays,
    speedup,
    estimate_basis: estimateBasis,
    candidates,
    unit_details: unitDetails,
  });
}
