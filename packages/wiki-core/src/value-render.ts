/**
 * value-render.ts — deterministic VAL finalize/render surface (WK-0058).
 *
 * Turns the frozen value-report + value-usage JSON and the operator-ratified per-row days into
 * the filled VAL Markdown body (review table, arithmetic, ROI + ceiling lines, Token Detail) plus
 * raw full-precision frontmatter numerics. Numbers come from CODE here, never the model —
 * SRC-0003 caught the agent hand-summing and printing `52.21153846…`.
 *
 * Precision split (WK-0058): the fmt* helpers are DISPLAY-ONLY (2-dp + thousands separators).
 * Persisted frontmatter numerics stay raw full-precision — cum_leverage sums the raw values, so a
 * rounded store would drift the chain.
 *
 * Rules: Result<T> where fallible; never throw. Locale-independent formatting (no Intl) for
 * cross-platform determinism, matching value-report.ts.
 */

import { ok, fail, type Result } from './errors.js';
import type {
  ValueReviewUnit,
  CodeUnitClass,
  RateFlag,
  UsageMetrics,
  ValueMetrics,
  ValueDataTrace,
  ValueCandidate,
} from './types.js';

/**
 * Thousands-separated integer string (token / LOC counts). Rounds a stray float to a whole
 * integer first. Display only — never persisted to frontmatter.
 */
export function fmtInt(n: number): string {
  const rounded = Math.round(n);
  const withSep = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rounded < 0 ? `-${withSep}` : withSep;
}

/**
 * 2-dp fixed value with thousands separators on the integer part. Display only — never persisted
 * to frontmatter. Fixes the SRC-0003 defect (leverage/replication printed at full float precision).
 */
export function fmtNum(n: number): string {
  const neg = n < 0;
  const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${withSep}.${decPart}`;
}

// ---------------------------------------------------------------------------
// VAL arithmetic (DEC-0003 flat-rate replication cost; raw full-precision)
// ---------------------------------------------------------------------------

/** One operator-ratified priced row: the exact review_units[].path + its ratified replication days. */
export interface RatifiedRow {
  path: string;
  ratified_days: number;
}

/** The two figures a prior published VAL contributes to the cumulative chain line. */
export interface PriorValNumbers {
  replication_days: number;
  work_days: number;
}

/** Computed VAL arithmetic — raw full-precision scalars (display rounding happens at render). */
export interface ValArithmetic {
  replication_days: number;
  /** replication_days − work_days; may be negative — never clamped (DEC-0003 floor semantics). */
  saved_floor_days: number;
  /** replication_days / work_days; uncapped, may be < 1 — never clamped. */
  leverage: number;
  units_valued: number;
  /**
   * Σ replication_days / Σ work_days over prior published VALs plus this span (body-only), or
   * `null` when the prior chain is unreadable (WK-0058: the chain is optional — never block a good
   * VAL on a broken prior link). `priors = []` (a genuine first VAL) still computes: cum == leverage.
   */
  cum_leverage: number | null;
}

/**
 * Compute the VAL arithmetic block from operator-ratified rows and the git-derived work_days.
 * Pure — no clamps, no rounding (the precision split keeps stored numerics full-precision).
 * `priors === null` signals an unreadable chain → cum_leverage omitted; an empty array is a valid
 * first-VAL chain.
 */
export function computeArithmetic(
  ratified: RatifiedRow[],
  work_days: number,
  priors: PriorValNumbers[] | null,
): ValArithmetic {
  const replication_days = ratified.reduce((sum, r) => sum + r.ratified_days, 0);
  const saved_floor_days = replication_days - work_days; // may be negative; never clamped
  const leverage = replication_days / work_days; // uncapped; may be < 1; never clamped
  const units_valued = ratified.length;

  let cum_leverage: number | null = null;
  if (priors !== null) {
    const cumReplication = priors.reduce((sum, p) => sum + p.replication_days, replication_days);
    const cumWork = priors.reduce((sum, p) => sum + p.work_days, work_days);
    cum_leverage = cumReplication / cumWork;
  }

  return { replication_days, saved_floor_days, leverage, units_valued, cum_leverage };
}

// ---------------------------------------------------------------------------
// Review table (## How This Was Calculated rows — the estimate basis, path-keyed)
// ---------------------------------------------------------------------------

/**
 * One resolved review row: a frozen review_unit joined with the operator's ratification.
 * `proposed_days` is the frozen `loc_reference` (net_loc / loc_per_day); `ratified_days` is the
 * operator override or, for an untouched row, the proposed floor. This row is BOTH a table line
 * and (structurally, via `path` + `ratified_days`) a `RatifiedRow` for `computeArithmetic`.
 */
export interface ResolvedRow {
  path: string;
  unitClass: CodeUnitClass;
  tier: ValueReviewUnit['tier'];
  wk_ids: string[];
  net_loc: number;
  /** Frozen net_loc / loc_per_day — the proposed floor and the >3× tripwire reference. */
  proposed_days: number;
  /** Operator override for this path, or the proposed floor when the row was left untouched. */
  ratified_days: number;
  rate_flag: RateFlag | null;
}

/**
 * Join the frozen `review_units` with the operator-ratified per-row days (path-keyed).
 * Contract (WK-0058): a ratified `path` absent from `review_units` is the wrong-row bug → fail
 * loud (never a silent add). A review_unit with no ratification defaults to its proposed floor.
 * Order follows `review_units`. Pure — returns a Result, never throws.
 */
export function resolveReviewRows(
  review_units: ValueReviewUnit[],
  ratified: RatifiedRow[],
): Result<ResolvedRow[]> {
  const byPath = new Map(review_units.map((u) => [u.path, u]));
  for (const r of ratified) {
    if (!byPath.has(r.path)) {
      return fail('INVALID_FIELD', `ratified path not in review_units: ${r.path}`);
    }
  }
  const overrides = new Map(ratified.map((r) => [r.path, r.ratified_days]));
  const rows: ResolvedRow[] = review_units.map((u) => {
    const proposed_days = u.loc_reference; // frozen net_loc / loc_per_day
    const override = overrides.get(u.path);
    return {
      path: u.path,
      unitClass: u.unitClass,
      tier: u.tier,
      wk_ids: u.wk_ids,
      net_loc: u.net_loc,
      proposed_days,
      ratified_days: override ?? proposed_days, // 0 is a valid veto; only absent → proposed
      rate_flag: u.rate_flag,
    };
  });
  return ok(rows);
}

/** Column headers for the review table, in render order. */
const REVIEW_HEADERS = [
  'path',
  'class',
  'tier',
  'wk_ids',
  'net_loc',
  'proposed_days',
  'ratified_days',
  'rate_flag',
];

/** One markdown table row from pre-formatted cells. */
function mdRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/**
 * Render the `## How This Was Calculated` review table (display: 2-dp + thousands separators).
 * Empty `wk_ids` / null `rate_flag` render as an em dash; multiple wk_ids join with `, `. The
 * bold total row sums net_loc and ratified_days (= replication_days). Deterministic — the model
 * never writes this table.
 */
export function renderReviewTable(rows: ResolvedRow[]): string {
  const header = mdRow(REVIEW_HEADERS);
  const sep = mdRow(REVIEW_HEADERS.map(() => '---'));
  const body = rows.map((r) =>
    mdRow([
      r.path,
      r.unitClass,
      r.tier,
      r.wk_ids.length > 0 ? r.wk_ids.join(', ') : '—',
      fmtInt(r.net_loc),
      fmtNum(r.proposed_days),
      fmtNum(r.ratified_days),
      r.rate_flag ?? '—',
    ]),
  );
  const totalNetLoc = rows.reduce((s, r) => s + r.net_loc, 0);
  const totalRatified = rows.reduce((s, r) => s + r.ratified_days, 0);
  const total = mdRow([
    '**total**',
    '',
    '',
    '',
    `**${fmtInt(totalNetLoc)}**`,
    '',
    `**${fmtNum(totalRatified)}**`,
    '',
  ]);
  return [header, sep, ...body, total].join('\n');
}

// ---------------------------------------------------------------------------
// Token Detail table (## Token Detail — per-model tokens + cost split, scraped)
// ---------------------------------------------------------------------------

/** Column headers for the Token Detail table, in render order. */
const TOKEN_HEADERS = [
  'model',
  'arm',
  'input',
  'output',
  'cache_read',
  'cache_write',
  'total',
  'cost_usd',
  'cost_usd_est',
];

/** A per-row/aggregate $ cell: null → em dash; a number → `$X.XX`. */
function fmtCost(v: number | null): string {
  return v === null ? '—' : `$${fmtNum(v)}`;
}

/**
 * Render the `## Token Detail` per-model table from scraped usage (display: separators + 2-dp $).
 * The two cost columns stay distinct: `cost_usd` (real/marginal out-of-pocket, null on
 * subscription/codex arms) and `cost_usd_est` (ccusage at-API-rates). The bold total row uses the
 * frozen top-level aggregates; a null aggregate `cost_usd` reads `$0 (null)` so a subscription
 * span is not misread as unpriced. Deterministic — the model never writes this table.
 */
export function renderTokenDetail(usage: UsageMetrics): string {
  const header = mdRow(TOKEN_HEADERS);
  const sep = mdRow(TOKEN_HEADERS.map(() => '---'));
  const body = usage.by_model.map((m) =>
    mdRow([
      m.model,
      m.arm,
      fmtInt(m.input_tokens),
      fmtInt(m.output_tokens),
      fmtInt(m.cache_read_tokens),
      fmtInt(m.cache_write_tokens),
      fmtInt(m.total_tokens),
      fmtCost(m.cost_usd),
      fmtCost(m.cost_usd_est),
    ]),
  );
  const totalCostUsd = usage.cost_usd === null ? '$0 (null)' : `$${fmtNum(usage.cost_usd)}`;
  const total = mdRow([
    '**total**',
    '',
    `**${fmtInt(usage.input_tokens)}**`,
    `**${fmtInt(usage.output_tokens)}**`,
    `**${fmtInt(usage.cache_read_tokens)}**`,
    `**${fmtInt(usage.cache_write_tokens)}**`,
    `**${fmtInt(usage.total_tokens)}**`,
    `**${totalCostUsd}**`,
    `**${fmtCost(usage.cost_usd_est)}**`,
  ]);
  return [header, sep, ...body, total].join('\n');
}

// ---------------------------------------------------------------------------
// Data traces + unclassified gate (WK-0059 widened surface — priced-0 / operator ruling)
// ---------------------------------------------------------------------------

/** Locale-independent string compare (no Intl — cross-platform determinism, matching this module). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render the priced-0 data/orphan_data traceability list (WK-0059). Detection only — these rows
 * are NEVER floor rows; the in-repo generator (if any) carries value as the code it is. Empty →
 * a stable "none" note so the body renders deterministically with nothing to price.
 */
export function renderDataTraces(traces: ValueDataTrace[]): string {
  if (traces.length === 0) return '_No data assets detected this span._';
  return [
    'Priced 0 — detection/traceability only (WK-0059); never a floor row.',
    '',
    mdRow(['path', 'class', 'net_loc', 'reason']),
    mdRow(['---', '---', '---', '---']),
    ...traces.map((t) => mdRow([t.path, t.unitClass, fmtInt(t.net_loc), t.reason])),
  ].join('\n');
}

/** One batched group of unknown-type candidates: same first path segment + same final extension. */
export interface UnclassifiedGroup {
  pathFamily: string;
  ext: string;
  paths: string[];
}

/** First path segment (the "family"); a root-level file has no family. */
function pathFamilyOf(p: string): string {
  const i = p.indexOf('/');
  return i === -1 ? '(root)' : p.slice(0, i);
}

/** Final extension including the dot, or `(none)` for an extensionless file (dotfiles included). */
function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '(none)';
}

/**
 * Group `unclassified` candidates by (path family, extension) so one operator ruling covers a
 * whole group instead of a per-file rubber-stamp (WK-0059). Classified candidates are ignored
 * (they belong to the code confirm/reject surface). Deterministic order: family then ext, paths sorted.
 */
export function groupUnclassified(candidates: ValueCandidate[]): UnclassifiedGroup[] {
  const map = new Map<string, UnclassifiedGroup>();
  for (const c of candidates) {
    if (c.unitClass !== 'unclassified') continue;
    const pathFamily = pathFamilyOf(c.path);
    const ext = extOf(c.path);
    const key = `${pathFamily} ${ext}`;
    const g = map.get(key);
    if (g) g.paths.push(c.path);
    else map.set(key, { pathFamily, ext, paths: [c.path] });
  }
  const groups = [...map.values()];
  for (const g of groups) g.paths.sort(cmp);
  groups.sort((a, b) => (a.pathFamily === b.pathFamily ? cmp(a.ext, b.ext) : cmp(a.pathFamily, b.pathFamily)));
  return groups;
}

/**
 * Render the batched unclassified-type ruling gate (WK-0059): one row per (family, ext) group,
 * each ruled code | data | doc by the operator and persisted to `wiki/.value-config.json`. When
 * the group count exceeds `maxNewGroups`, a threshold warning is prepended — the guard against the
 * approve-defaults-under-volume attention-DoS. Empty → a stable "none" note.
 */
export function renderUnclassifiedGroups(candidates: ValueCandidate[], maxNewGroups = 10): string {
  const groups = groupUnclassified(candidates);
  if (groups.length === 0) return '_No unclassified types this span._';
  const lines = [
    'Rule each group code | data | doc; the ruling persists to wiki/.value-config.json (WK-0059). One ruling applies to every file in the group.',
    '',
    mdRow(['path family', 'ext', 'count', 'files']),
    mdRow(['---', '---', '---', '---']),
    ...groups.map((g) => mdRow([g.pathFamily, g.ext, fmtInt(g.paths.length), g.paths.join(', ')])),
  ];
  if (groups.length > maxNewGroups) {
    lines.unshift(
      `⚠ ${fmtInt(groups.length)} novel-type groups exceed the max-new-candidate threshold (${fmtInt(maxNewGroups)}) — review each; do not rubber-stamp.`,
      '',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Headline lines (the printed ROI + display-only ceiling — recipe step 6)
// ---------------------------------------------------------------------------

/** Inputs for the printed ROI headline. Numbers are raw; the renderer applies the display split. */
export interface RoiLineInput {
  units_valued: number;
  /** Real/marginal out-of-pocket $, or null for a pure subscription-covered span. */
  cost_usd: number | null;
  /** ccusage at-API-rates estimate, or null when nothing could be priced. */
  cost_usd_est: number | null;
  total_tokens: number;
  replication_days: number;
  work_days: number;
  leverage: number;
  cum_leverage: number | null;
}

/**
 * Render the ROI headline (recipe step 6). Deterministic string assembly — the model never writes
 * this line. cost_usd null → "$0 out-of-pocket" (the estimate carries the interpretable figure);
 * cum_leverage null → "chain n/a" (the chain is optional, WK-0058).
 */
export function renderRoiLine(i: RoiLineInput): string {
  const cost = i.cost_usd === null ? '$0 out-of-pocket' : `$${fmtNum(i.cost_usd)}`;
  const est = i.cost_usd_est === null ? 'est. unavailable' : `est. $${fmtNum(i.cost_usd_est)} at API rates`;
  const chain = i.cum_leverage === null ? 'chain n/a' : `chain ${fmtNum(i.cum_leverage)}×`;
  return (
    `shipped ${fmtInt(i.units_valued)} working units; ` +
    `agents cost ${cost} (${est}) / ${fmtInt(i.total_tokens)} tokens; ` +
    `replication value ${fmtNum(i.replication_days)} operator-days vs ${fmtInt(i.work_days)} days worked → ` +
    `leverage ${fmtNum(i.leverage)}× (floor); ${chain}`
  );
}

/** Inputs for the display-only COCOMO ceiling reference line. */
export interface CeilingLineInput {
  cocomo_pm_nominal: number;
  cocomo_kloc: number;
}

/**
 * Render the display-only ceiling reference line (recipe step 6). Never enters arithmetic — it is
 * the one non-self-calibrated external reference (Boehm 2000, frozen nominal constants).
 */
export function renderCeilingLine(i: CeilingLineInput): string {
  return (
    `reference ceiling: COCOMO II nominal ≈ ${fmtNum(i.cocomo_pm_nominal)} person-months ` +
    `for ${fmtNum(i.cocomo_kloc)} KSLOC (frozen nominal constants, Boehm 2000)`
  );
}

// ---------------------------------------------------------------------------
// renderValueReport — the deterministic VAL body assembly (WK-0058 finalize)
// ---------------------------------------------------------------------------

/**
 * The arithmetic recap block under `## How This Was Calculated` (display 2-dp; work_days as an
 * integer day count). Every number is reproducible from the ratified rows above it. cum_leverage
 * null → the chain-unreadable note (WK-0058: the chain is optional).
 */
function renderArithmeticBlock(a: ValArithmetic, work_days: number): string {
  const cum =
    a.cum_leverage === null
      ? 'n/a (prior chain unreadable — span published on its own numbers)'
      : `Σ replication_days / Σ work_days over the published chain = ${fmtNum(a.cum_leverage)}×`;
  return [
    '**Arithmetic** (DEC-0003 flat-260 replication cost; frontmatter stores raw full precision, shown 2-dp):',
    '',
    `- replication_days = Σ ratified_days = ${fmtNum(a.replication_days)}`,
    `- saved_floor_days = replication_days − work_days = ${fmtNum(a.replication_days)} − ${fmtInt(work_days)} = ${fmtNum(a.saved_floor_days)}`,
    `- leverage = replication_days / work_days = ${fmtNum(a.replication_days)} / ${fmtInt(work_days)} = ${fmtNum(a.leverage)}× (floor; uncapped)`,
    `- cum_leverage = ${cum}`,
  ].join('\n');
}

/** Inputs to the finalize: the frozen tool JSON + operator ratifications + the prior chain. */
export interface RenderValueReportInput {
  /** value-report JSON (frozen at draft). */
  metrics: ValueMetrics;
  /** value-usage JSON (frozen at draft). */
  usage: UsageMetrics;
  /** Operator-ratified per-row days, path-keyed; a row left untouched defaults to its proposed floor. */
  ratified: RatifiedRow[];
  /** Prior published VALs' numbers for cum_leverage, or null when the chain is unreadable. */
  priors: PriorValNumbers[] | null;
}

/** The finalize output: raw frontmatter numerics + display-formatted Markdown sections. */
export interface RenderedVal {
  /**
   * RAW full-precision frontmatter numerics — never the display strings (a rounded store would
   * drift a later cum_leverage). cum_leverage is body-only and returned separately, below.
   */
  frontmatter: {
    replication_days: number;
    saved_floor_days: number;
    leverage: number;
    units_valued: number;
  };
  /** Body-only cum_leverage (raw), or null when the chain is unreadable (WK-0058: chain optional). */
  cum_leverage: number | null;
  /** Deterministic Markdown sections (display-formatted) the agent splices under the record's headings. */
  sections: {
    /** `## How This Was Calculated`: the review table + the arithmetic recap block. */
    howCalculated: string;
    /** `## Token Detail`: the per-model token/cost table. */
    tokenDetail: string;
    /** Priced-0 data/orphan_data traceability list (WK-0059); a "none" note when empty. */
    dataTraces: string;
    /** Batched unclassified-type ruling gate (WK-0059); a "none" note when empty. */
    unclassified: string;
    /** ROI headline line (printed in `## Agent Value`). */
    roiLine: string;
    /** Display-only COCOMO ceiling reference line (printed after the ROI line). */
    ceilingLine: string;
  };
}

/**
 * Render the deterministic VAL body from the frozen tool JSON + operator ratifications.
 * Every number comes from CODE (SRC-0003: the agent must never hand-sum, printing 52.21153846…).
 * Fails loud (Result err) when a ratified path is absent from the frozen review_units; never throws.
 */
export function renderValueReport(input: RenderValueReportInput): Result<RenderedVal> {
  const { metrics, usage, ratified, priors } = input;

  const resolved = resolveReviewRows(metrics.review_units, ratified);
  if (!resolved.ok) return resolved; // propagate the path-key fail-loud

  const arithmetic = computeArithmetic(resolved.data, metrics.work_days, priors);

  const howCalculated = [
    renderReviewTable(resolved.data),
    '',
    renderArithmeticBlock(arithmetic, metrics.work_days),
  ].join('\n');

  const roiLine = renderRoiLine({
    units_valued: arithmetic.units_valued,
    cost_usd: usage.cost_usd,
    cost_usd_est: usage.cost_usd_est,
    total_tokens: usage.total_tokens,
    replication_days: arithmetic.replication_days,
    work_days: metrics.work_days,
    leverage: arithmetic.leverage,
    cum_leverage: arithmetic.cum_leverage,
  });

  const ceilingLine = renderCeilingLine({
    cocomo_pm_nominal: metrics.cocomo_pm_nominal,
    cocomo_kloc: metrics.cocomo_kloc,
  });

  return ok({
    frontmatter: {
      replication_days: arithmetic.replication_days,
      saved_floor_days: arithmetic.saved_floor_days,
      leverage: arithmetic.leverage,
      units_valued: arithmetic.units_valued,
    },
    cum_leverage: arithmetic.cum_leverage,
    sections: {
      howCalculated,
      tokenDetail: renderTokenDetail(usage),
      dataTraces: renderDataTraces(metrics.data_traces),
      unclassified: renderUnclassifiedGroups(metrics.candidates),
      roiLine,
      ceilingLine,
    },
  });
}
