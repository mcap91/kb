/**
 * Tests for value-render.ts — the deterministic VAL finalize/render surface (WK-0058).
 *
 * TDD: tests written first. The pure display + arithmetic helpers here need no git fixtures;
 * renderValueReport() golden tests join the JSON facts + operator-ratified rows later.
 *
 * Precision split (WK-0058): fmt* helpers are DISPLAY-ONLY. Persisted frontmatter numerics stay
 * raw full-precision — cum_leverage sums the raw values, so a rounded store would drift the chain.
 */

import { describe, it, expect } from 'vitest';
import {
  fmtInt,
  fmtNum,
  computeArithmetic,
  renderRoiLine,
  renderCeilingLine,
  resolveReviewRows,
  renderReviewTable,
  renderTokenDetail,
  renderValueReport,
  renderDataTraces,
  groupUnclassified,
  renderUnclassifiedGroups,
} from '../packages/wiki-core/src/value-render.js';
import type { ResolvedRow } from '../packages/wiki-core/src/value-render.js';
import type {
  ValueReviewUnit,
  UsageMetrics,
  ValueDataTrace,
  ValueCandidate,
} from '../packages/wiki-core/src/types.js';
import { makeMetrics, makeUsage, GOLDEN_UNITS } from './helpers/value-fixtures.js';
import { LITELLM_TABLE_VERSION } from '../packages/wiki-core/src/pricing.js';

describe('fmtInt — thousands-separated integers (display only)', () => {
  it('separates a long integer (token/LOC counts) into thousands groups', () => {
    expect(fmtInt(87300000)).toBe('87,300,000');
  });

  it('leaves sub-thousand values unseparated', () => {
    expect(fmtInt(842)).toBe('842');
  });

  it('rounds a stray fractional input to a whole integer before separating', () => {
    expect(fmtInt(1234.6)).toBe('1,235');
  });
});

describe('fmtNum — 2-dp fixed with thousands separators (display only)', () => {
  it('rounds to two decimals (the SRC-0003 52.21153846… defect)', () => {
    expect(fmtNum(52.21153846153845)).toBe('52.21');
  });

  it('keeps two trailing decimals and separates the integer part', () => {
    expect(fmtNum(1234.5)).toBe('1,234.50');
  });

  it('formats a negative value (saved_floor_days < 0 / leverage < 1 spans)', () => {
    expect(fmtNum(-3.4)).toBe('-3.40');
  });
});

describe('computeArithmetic — replication / floor / leverage (DEC-0003 flat semantics)', () => {
  it('replication_days = Σ ratified_days; units_valued = row count', () => {
    const a = computeArithmetic(
      [{ path: 'a', ratified_days: 3 }, { path: 'b', ratified_days: 2.5 }, { path: 'c', ratified_days: 0.5 }],
      10,
      [],
    );
    expect(a.replication_days).toBe(6);
    expect(a.units_valued).toBe(3);
  });

  it('saved_floor_days may be negative and is never clamped', () => {
    const a = computeArithmetic([{ path: 'a', ratified_days: 6 }], 10, []);
    expect(a.saved_floor_days).toBe(-4);
  });

  it('leverage may be < 1 and is never clamped', () => {
    const a = computeArithmetic([{ path: 'a', ratified_days: 6 }], 10, []);
    expect(a.leverage).toBeCloseTo(0.6, 10);
  });

  it('leverage is uncapped — no ×10 ceiling (DEC-0003 retired the cap)', () => {
    const a = computeArithmetic([{ path: 'a', ratified_days: 150 }], 10, []);
    expect(a.leverage).toBe(15);
  });
});

describe('computeArithmetic — cum_leverage over the published chain (body-only, raw precision)', () => {
  it('sums replication and work_days across priors plus this span', () => {
    const priors = [
      { replication_days: 8, work_days: 2 },
      { replication_days: 12, work_days: 3 },
    ];
    // (8 + 12 + 6) / (2 + 3 + 5) = 26 / 10 = 2.6
    const a = computeArithmetic([{ path: 'a', ratified_days: 6 }], 5, priors);
    expect(a.cum_leverage).toBeCloseTo(2.6, 10);
  });

  it('omits cum_leverage (null) when the prior chain is unreadable; span leverage still computes', () => {
    const a = computeArithmetic([{ path: 'a', ratified_days: 6 }], 5, null);
    expect(a.cum_leverage).toBeNull();
    expect(a.leverage).toBeCloseTo(1.2, 10);
  });

  it('first VAL (no priors) → cum_leverage equals the span leverage', () => {
    const a = computeArithmetic([{ path: 'a', ratified_days: 6 }], 5, []);
    expect(a.cum_leverage).toBeCloseTo(1.2, 10);
    expect(a.leverage).toBeCloseTo(1.2, 10);
  });
});

describe('renderRoiLine — the printed ROI headline (2-dp + separators)', () => {
  it('renders the single est_usd cost surface (WK-0066: no actual / out-of-pocket split)', () => {
    // Why: WK-0066 collapsed the cost side to one figure — tokens × table. The line names the
    // estimate directly ("est. $X at API rates"), never a two-number actual/estimate split.
    const line = renderRoiLine({
      units_valued: 26,
      est_usd: 116.57,
      total_tokens: 87300000,
      replication_days: 52.21153846153845,
      work_days: 13,
      leverage: 4.02,
      cum_leverage: 4.02,
    });
    expect(line).toBe(
      'shipped 26 working units; agents cost est. $116.57 at API rates / ' +
        '87,300,000 tokens; replication value 52.21 operator-days vs 13 days worked → ' +
        'leverage 4.02× (floor); chain 4.02×',
    );
  });

  it('renders "est. unavailable" when nothing could be priced (est_usd null, never a silent $0)', () => {
    // Why: a span of only unknown-remote models prices to null — the line must say so, not imply $0.
    const line = renderRoiLine({
      units_valued: 5,
      est_usd: null,
      total_tokens: 1000,
      replication_days: 3,
      work_days: 2,
      leverage: 1.5,
      cum_leverage: 1.5,
    });
    expect(line).toBe(
      'shipped 5 working units; agents cost est. unavailable / 1,000 tokens; ' +
        'replication value 3.00 operator-days vs 2 days worked → leverage 1.50× (floor); chain 1.50×',
    );
  });

  it('marks the chain n/a when cum_leverage is unavailable (broken prior link)', () => {
    const line = renderRoiLine({
      units_valued: 5,
      est_usd: 1,
      total_tokens: 1000,
      replication_days: 3,
      work_days: 2,
      leverage: 1.5,
      cum_leverage: null,
    });
    expect(line).toBe(
      'shipped 5 working units; agents cost est. $1.00 at API rates / 1,000 tokens; ' +
        'replication value 3.00 operator-days vs 2 days worked → leverage 1.50× (floor); chain n/a',
    );
  });
});

describe('renderCeilingLine — display-only COCOMO reference', () => {
  it('renders the frozen-nominal ceiling reference line', () => {
    const line = renderCeilingLine({ cocomo_pm_nominal: 19.02, cocomo_kloc: 5.573 });
    expect(line).toBe(
      'reference ceiling: COCOMO II nominal ≈ 19.02 person-months for 5.57 KSLOC ' +
        '(frozen nominal constants, Boehm 2000)',
    );
  });
});

// A review unit with test-friendly defaults; loc_reference defaults to the frozen net_loc/260.
function ru(
  partial: Partial<ValueReviewUnit> & { path: string; net_loc: number },
): ValueReviewUnit {
  return {
    path: partial.path,
    unitClass: partial.unitClass ?? 'modules',
    tier: partial.tier ?? 'tested',
    wk_ids: partial.wk_ids ?? ['WK-0058'],
    net_loc: partial.net_loc,
    loc_reference: partial.loc_reference ?? partial.net_loc / 260,
    rate_flag: partial.rate_flag ?? null,
  };
}

describe('resolveReviewRows — path-keyed ratification (default = proposed, fail loud on wrong path)', () => {
  it('defaults an untouched row to proposed_days (= loc_reference); applies an override to its keyed row', () => {
    // Why: the operator only touches the rows they disagree with; every other priced row must
    // still land in the estimate at its proposed floor, never silently dropped or zeroed.
    const units = [ru({ path: 'a/x.ts', net_loc: 260 }), ru({ path: 'b/y.ts', net_loc: 520 })];
    const res = resolveReviewRows(units, [{ path: 'b/y.ts', ratified_days: 3.5 }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]).toMatchObject({ path: 'a/x.ts', proposed_days: 1, ratified_days: 1 });
    expect(res.data[1]).toMatchObject({ path: 'b/y.ts', proposed_days: 2, ratified_days: 3.5 });
  });

  it('fails loud (Result error naming the path) when a ratified path is absent from review_units', () => {
    // Why: a ratification landing on a path the tool never measured is the wrong-row bug the
    // path-key contract exists to catch — it must error, never silently add a row.
    const units = [ru({ path: 'a/x.ts', net_loc: 260 })];
    const res = resolveReviewRows(units, [{ path: 'does/not/exist.ts', ratified_days: 1 }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('does/not/exist.ts');
  });

  it('keys overrides by full path, not basename (duplicate-basename fixture)', () => {
    // Why: two files can share a basename (src/index.ts vs web/index.ts); keying on anything but
    // the full path would apply the operator's adjustment to the wrong unit.
    const units = [ru({ path: 'src/index.ts', net_loc: 260 }), ru({ path: 'web/index.ts', net_loc: 260 })];
    const res = resolveReviewRows(units, [{ path: 'web/index.ts', ratified_days: 9 }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.find((r) => r.path === 'src/index.ts')!.ratified_days).toBe(1);
    expect(res.data.find((r) => r.path === 'web/index.ts')!.ratified_days).toBe(9);
  });

  it('preserves review_units order in the resolved rows', () => {
    const units = [ru({ path: 'z.ts', net_loc: 260 }), ru({ path: 'a.ts', net_loc: 260 })];
    const res = resolveReviewRows(units, []);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((r) => r.path)).toEqual(['z.ts', 'a.ts']);
  });
});

describe('renderReviewTable — the ## How This Was Calculated review rows (2-dp + separators)', () => {
  it('renders header, per-row cells, and a bold total row', () => {
    const rows: ResolvedRow[] = [
      {
        path: 'packages/wiki-core/src/value-render.ts',
        unitClass: 'modules',
        tier: 'tested',
        wk_ids: ['WK-0058'],
        net_loc: 147,
        proposed_days: 147 / 260,
        ratified_days: 0.75,
        rate_flag: null,
      },
      {
        path: 'tests/value-render.test.ts',
        unitClass: 'modules',
        tier: 'tested',
        wk_ids: ['WK-0058'],
        net_loc: 1300,
        proposed_days: 5,
        ratified_days: 5,
        rate_flag: 'test-code',
      },
    ];
    expect(renderReviewTable(rows)).toBe(
      [
        '| path | class | tier | wk_ids | net_loc | proposed_days | ratified_days | rate_flag |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| packages/wiki-core/src/value-render.ts | modules | tested | WK-0058 | 147 | 0.57 | 0.75 | — |',
        '| tests/value-render.test.ts | modules | tested | WK-0058 | 1,300 | 5.00 | 5.00 | test-code |',
        '| **total** |  |  |  | **1,447** |  | **5.75** |  |',
      ].join('\n'),
    );
  });

  it('renders — for empty wk_ids / null rate_flag and joins multiple wk_ids with commas', () => {
    const rows: ResolvedRow[] = [
      {
        path: 'a.ts',
        unitClass: 'scripts',
        tier: 'wired',
        wk_ids: [],
        net_loc: 10,
        proposed_days: 10 / 260,
        ratified_days: 0.1,
        rate_flag: null,
      },
      {
        path: 'b.ts',
        unitClass: 'modules',
        tier: 'tested',
        wk_ids: ['WK-0058', 'WK-0059'],
        net_loc: 20,
        proposed_days: 20 / 260,
        ratified_days: 0.2,
        rate_flag: null,
      },
    ];
    const out = renderReviewTable(rows);
    expect(out).toContain('| a.ts | scripts | wired | — | 10 | 0.04 | 0.10 | — |');
    expect(out).toContain('| b.ts | modules | tested | WK-0058, WK-0059 | 20 | 0.08 | 0.20 | — |');
  });
});

describe('renderTokenDetail — the ## Token Detail section (per-model + by-provider + provenance)', () => {
  it('renders per-model rows, a by-provider subtotal, and a table-version provenance line', () => {
    // Why: the single cost surface (WK-0066) is est_usd = tokens × table — no effort column, no
    // actual/estimate split. The provider subtotal is the DEC-0005 provider dimension; the
    // provenance line names the pinned table and states these are list rates, not a bill.
    expect(renderTokenDetail(makeUsage())).toBe(
      [
        '| model | provider | input | output | cache_read | cache_write | total | est_usd |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| claude-opus-4-8 | anthropic | 81,516 | 683,867 | 53,313,057 | 1,726,318 | 55,804,758 | $61.42 |',
        '| claude-sonnet-4-6 | anthropic | 90 | 61,045 | 4,595,592 | 229,528 | 4,886,255 | $3.16 |',
        '| **total** |  | **81,606** | **744,912** | **57,908,649** | **1,955,846** | **60,691,013** | **$64.58** |',
        '',
        '**By provider:**',
        '',
        '| provider | input | output | cache_read | cache_write | total | est_usd |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| anthropic | 81,606 | 744,912 | 57,908,649 | 1,955,846 | 60,691,013 | $64.58 |',
        '',
        `Priced via LiteLLM table ${LITELLM_TABLE_VERSION} (tokens × table list rates; not a bill).`,
      ].join('\n'),
    );
  });

  it('an unknown remote model renders an em-dash est_usd + carries its reason (never a silent $0)', () => {
    // Why: an unknown remote model prices to null — the row + total show an em dash (its est_reason
    // lives on the row), never a fabricated $0 that would undercount real spend.
    const usage: UsageMetrics = {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 300,
      est_usd: null,
      pricing_table_version: LITELLM_TABLE_VERSION,
      agents: ['dispatch'],
      by_model: [
        {
          model: 'z-ai/glm-5.2',
          provider: 'unknown',
          input_tokens: 100,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 300,
          est_usd: null,
          est_reason: 'no LiteLLM price row for model "z-ai/glm-5.2"',
        },
      ],
      by_provider: [
        {
          provider: 'unknown',
          input_tokens: 100,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 300,
          est_usd: null,
        },
      ],
      attribution: 'date-window-approx',
    };
    const out = renderTokenDetail(usage);
    expect(out).toContain('| z-ai/glm-5.2 | unknown | 100 | 200 | 0 | 0 | 300 | — |');
    expect(out).toContain('| **total** |  | **100** | **200** | **0** | **0** | **300** | **—** |');
    expect(out).toContain(`Priced via LiteLLM table ${LITELLM_TABLE_VERSION} (tokens × table list rates; not a bill).`);
  });

  it('renders a local/self-hosted (dispatch + ollama) row at est_usd $0.00, never null', () => {
    // Why: WK-0066/DEC-0005 addendum — a local run has no dollar cost and is NOT priced at a
    // substitute model's rate. It shows tokens + a real $0.00 (provider 'local'), never an em dash.
    const usage: UsageMetrics = {
      input_tokens: 500,
      output_tokens: 250,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 750,
      est_usd: 0,
      pricing_table_version: LITELLM_TABLE_VERSION,
      agents: ['dispatch'],
      by_model: [
        {
          model: 'qwen3-coder:30b',
          provider: 'local',
          input_tokens: 500,
          output_tokens: 250,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 750,
          est_usd: 0,
          est_reason: null,
        },
      ],
      by_provider: [
        {
          provider: 'local',
          input_tokens: 500,
          output_tokens: 250,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 750,
          est_usd: 0,
        },
      ],
      attribution: 'date-window-approx',
    };
    const out = renderTokenDetail(usage);
    expect(out).toContain('| qwen3-coder:30b | local | 500 | 250 | 0 | 0 | 750 | $0.00 |');
  });
});

describe('renderValueReport — full deterministic assembly (golden, byte-stable)', () => {
  it('composes review table + arithmetic + token detail + ROI/ceiling and raw frontmatter numerics', () => {
    // Why: this is the whole point of WK-0058 — the deterministic body must come from CODE, exact
    // and reproducible, so the agent never hand-sums (SRC-0003 printed 52.21153846…). The operator
    // adjusts only the test file down (test-code rate mis-price); every number below is hand-checked.
    const metrics = makeMetrics({
      review_units: GOLDEN_UNITS,
      work_days: 1,
      cocomo_pm_nominal: 19.02,
      cocomo_kloc: 5.573,
    });
    const res = renderValueReport({
      metrics,
      usage: makeUsage(),
      ratified: [{ path: 'tests/value-render.test.ts', ratified_days: 1.0 }],
      priors: [{ replication_days: 6, work_days: 2 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // (b) Frontmatter numerics — RAW full precision (cum_leverage is body-only, returned apart).
    expect(res.data.frontmatter).toEqual({
      replication_days: 2,
      saved_floor_days: 1,
      leverage: 2,
      units_valued: 2,
    });
    expect(res.data.cum_leverage).toBeCloseTo(8 / 3, 10); // (6+2)/(2+1)

    // (a) ## How This Was Calculated — review rows + the arithmetic recap.
    expect(res.data.sections.howCalculated).toBe(
      [
        '| path | class | tier | wk_ids | net_loc | proposed_days | ratified_days | rate_flag |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| packages/wiki-core/src/value-render.ts | modules | tested | WK-0058 | 260 | 1.00 | 1.00 | — |',
        '| tests/value-render.test.ts | modules | tested | WK-0058 | 520 | 2.00 | 1.00 | test-code |',
        '| **total** |  |  |  | **780** |  | **2.00** |  |',
        '',
        '**Arithmetic** (DEC-0003 flat-260 replication cost; frontmatter stores raw full precision, shown 2-dp):',
        '',
        '- replication_days = Σ ratified_days = 2.00',
        '- saved_floor_days = replication_days − work_days = 2.00 − 1 = 1.00',
        '- leverage = replication_days / work_days = 2.00 / 1 = 2.00× (floor; uncapped)',
        '- cum_leverage = Σ replication_days / Σ work_days over the published chain = 2.67×',
      ].join('\n'),
    );

    // (a) ## Token Detail — per-model table + by-provider subtotal + provenance line.
    expect(res.data.sections.tokenDetail).toBe(
      [
        '| model | provider | input | output | cache_read | cache_write | total | est_usd |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| claude-opus-4-8 | anthropic | 81,516 | 683,867 | 53,313,057 | 1,726,318 | 55,804,758 | $61.42 |',
        '| claude-sonnet-4-6 | anthropic | 90 | 61,045 | 4,595,592 | 229,528 | 4,886,255 | $3.16 |',
        '| **total** |  | **81,606** | **744,912** | **57,908,649** | **1,955,846** | **60,691,013** | **$64.58** |',
        '',
        '**By provider:**',
        '',
        '| provider | input | output | cache_read | cache_write | total | est_usd |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| anthropic | 81,606 | 744,912 | 57,908,649 | 1,955,846 | 60,691,013 | $64.58 |',
        '',
        `Priced via LiteLLM table ${LITELLM_TABLE_VERSION} (tokens × table list rates; not a bill).`,
      ].join('\n'),
    );

    // (a) ROI + ceiling lines.
    expect(res.data.sections.roiLine).toBe(
      'shipped 2 working units; agents cost est. $64.58 at API rates / ' +
        '60,691,013 tokens; replication value 2.00 operator-days vs 1 days worked → ' +
        'leverage 2.00× (floor); chain 2.67×',
    );
    expect(res.data.sections.ceilingLine).toBe(
      'reference ceiling: COCOMO II nominal ≈ 19.02 person-months for 5.57 KSLOC ' +
        '(frozen nominal constants, Boehm 2000)',
    );
  });

  it('propagates the path-key fail-loud error when a ratified path is not in review_units', () => {
    const metrics = makeMetrics({ review_units: GOLDEN_UNITS, work_days: 1 });
    const res = renderValueReport({
      metrics,
      usage: makeUsage(),
      ratified: [{ path: 'nope/ghost.ts', ratified_days: 1 }],
      priors: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('nope/ghost.ts');
  });

  it('null priors → cum_leverage null and the ROI line reads "chain n/a" (chain optional)', () => {
    const metrics = makeMetrics({ review_units: GOLDEN_UNITS, work_days: 1 });
    const res = renderValueReport({
      metrics,
      usage: makeUsage(),
      ratified: [],
      priors: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.cum_leverage).toBeNull();
    expect(res.data.sections.roiLine).toContain('chain n/a');
    expect(res.data.sections.howCalculated).toContain(
      '- cum_leverage = n/a (prior chain unreadable — span published on its own numbers)',
    );
  });

  it('renders empty data-trace / unclassified sections as their "none" notes (golden fixture)', () => {
    // Why: the golden fixture ships no data/unclassified files, so the WK-0059 rows degrade to a
    // stable placeholder — the body still renders deterministically with nothing to price.
    const metrics = makeMetrics({ review_units: GOLDEN_UNITS, work_days: 1 });
    const res = renderValueReport({ metrics, usage: makeUsage(), ratified: [], priors: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sections.dataTraces).toBe('_No data assets detected this span._');
    expect(res.data.sections.unclassified).toBe('_No unclassified types this span._');
  });
});

describe('renderDataTraces — priced-0 data/orphan_data traceability list (WK-0059)', () => {
  it('renders a "none" note when there are no data assets', () => {
    expect(renderDataTraces([])).toBe('_No data assets detected this span._');
  });

  it('lists data + orphan_data rows with a priced-0 lead note (never a floor row)', () => {
    // Why: WK-0059 prices every data file 0 — the list is traceability only. orphan_data (curated,
    // no in-repo generator) sits in the same list, unpriced and flagged by its reason.
    const traces: ValueDataTrace[] = [
      { path: 'registry/datasets.csv', unitClass: 'data', net_loc: 12, reason: 'data-extension:.csv' },
      { path: 'data/curated_panel.csv', unitClass: 'orphan_data', net_loc: 0, reason: 'orphan_data_glob' },
    ];
    expect(renderDataTraces(traces)).toBe(
      [
        'Priced 0 — detection/traceability only (WK-0059); never a floor row.',
        '',
        '| path | class | net_loc | reason |',
        '| --- | --- | --- | --- |',
        '| registry/datasets.csv | data | 12 | data-extension:.csv |',
        '| data/curated_panel.csv | orphan_data | 0 | orphan_data_glob |',
      ].join('\n'),
    );
  });
});

describe('groupUnclassified — batch unknown types by path family + extension (WK-0059 gate)', () => {
  it('groups unclassified candidates by (path family, ext), ignores classified ones, sorts stably', () => {
    // Why: the batched gate exists so one ruling covers a whole ext+family group instead of a
    // per-file rubber-stamp; classified candidates belong to the code confirm/reject surface.
    const cands: ValueCandidate[] = [
      { path: 'pipeline/step2.cwl', unitClass: 'unclassified', reason: 'unknown-extension:.cwl' },
      { path: 'pipeline/step.cwl', unitClass: 'unclassified', reason: 'unknown-extension:.cwl' },
      { path: 'scripts/run', unitClass: 'unclassified', reason: 'extensionless-no-shebang' },
      { path: 'src/mod.ts', unitClass: 'modules', reason: 'candidate-location:src' },
    ];
    expect(groupUnclassified(cands)).toEqual([
      { pathFamily: 'pipeline', ext: '.cwl', paths: ['pipeline/step.cwl', 'pipeline/step2.cwl'] },
      { pathFamily: 'scripts', ext: '(none)', paths: ['scripts/run'] },
    ]);
  });
});

describe('renderUnclassifiedGroups — batched ruling gate + max-new threshold (WK-0059)', () => {
  it('renders a "none" note when there are no unclassified types', () => {
    expect(renderUnclassifiedGroups([])).toBe('_No unclassified types this span._');
  });

  it('renders one row per (family, ext) group with a persist-to-config lead note', () => {
    const cands: ValueCandidate[] = [
      { path: 'pipeline/step.cwl', unitClass: 'unclassified', reason: 'unknown-extension:.cwl' },
      { path: 'pipeline/step2.cwl', unitClass: 'unclassified', reason: 'unknown-extension:.cwl' },
      { path: 'scripts/run', unitClass: 'unclassified', reason: 'extensionless-no-shebang' },
    ];
    expect(renderUnclassifiedGroups(cands)).toBe(
      [
        'Rule each group code | data | doc; the ruling persists to wiki/.value-config.json (WK-0059). One ruling applies to every file in the group.',
        '',
        '| path family | ext | count | files |',
        '| --- | --- | --- | --- |',
        '| pipeline | .cwl | 2 | pipeline/step.cwl, pipeline/step2.cwl |',
        '| scripts | (none) | 1 | scripts/run |',
      ].join('\n'),
    );
  });

  it('prepends a threshold warning when the group count exceeds max-new (anti rubber-stamp)', () => {
    // Why: high novel-type volume is the attention-DoS the threshold guards — the operator must be
    // warned to review rather than approve defaults en masse.
    const many: ValueCandidate[] = [
      { path: 'a/x.q', unitClass: 'unclassified', reason: 'unknown-extension:.q' },
      { path: 'b/x.r', unitClass: 'unclassified', reason: 'unknown-extension:.r' },
      { path: 'c/x.s', unitClass: 'unclassified', reason: 'unknown-extension:.s' },
    ];
    const out = renderUnclassifiedGroups(many, 2);
    expect(out).toContain(
      '⚠ 3 novel-type groups exceed the max-new-candidate threshold (2) — review each; do not rubber-stamp.',
    );
  });
});

describe('SRC-0003 regression — precision split (raw frontmatter numeric, 2-dp display)', () => {
  it('keeps the raw full-precision replication_days while the ROI line shows 2-dp (no digit leak)', () => {
    // WHY: SRC-0003's defect was the agent hand-summing and printing 52.21153846153845 (and
    // 740.3097241700002) in the ROI line. The fix is the precision split — frontmatter stores the
    // RAW value (the cum_leverage chain needs it), the display rounds. Same numbers, presentation
    // only. This locks that the raw digits never leak back into the rendered body.
    const metrics = makeMetrics({
      review_units: [
        {
          path: 'analysis/big.R',
          unitClass: 'scripts',
          tier: 'survives',
          wk_ids: [],
          net_loc: 13575, // 13575 / 260 = 52.21153846… — the SRC-0003 figure
          loc_reference: 13575 / 260,
          rate_flag: null,
        },
      ],
      work_days: 1,
      cocomo_pm_nominal: 19.02,
      cocomo_kloc: 5.573,
    });
    const usage = { ...makeUsage(), est_usd: 740.3097241700002 }; // the other SRC-0003 figure
    const res = renderValueReport({ metrics, usage, ratified: [], priors: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Raw frontmatter numeric — full precision, numerically equal to the hand-computed value.
    expect(res.data.frontmatter.replication_days).toBe(13575 / 260);
    // Display — 2-dp, thousands-separated; the raw digits never appear in the body.
    expect(res.data.sections.roiLine).toContain('replication value 52.21 operator-days');
    expect(res.data.sections.roiLine).toContain('est. $740.31 at API rates');
    expect(res.data.sections.roiLine).not.toContain('52.2115');
    expect(res.data.sections.roiLine).not.toContain('740.3097');
  });
});
