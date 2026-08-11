/**
 * Tests for value-finalize.ts — the WK-0058 finalize tool entry.
 *
 * TDD: tests first. readPublishedPriors gathers the cumulative chain off disk (published VALs only,
 * null-degrading on an unreadable link); finalizeValueReport wires that into the pure
 * renderValueReport(). Uses the shared VAL fixtures + writeRecord; no git needed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  readPublishedPriors,
  finalizeValueReport,
} from '../packages/wiki-core/src/value-finalize.js';
import { createTmpDir, createBootstrappedRepo, writeRecord } from './helpers/tmp-repo.js';
import type { TmpRepo } from './helpers/tmp-repo.js';
import { lint } from '../packages/wiki-core/src/index.js';
import { makeMetrics, makeUsage, GOLDEN_UNITS } from './helpers/value-fixtures.js';

/** Write a VAL record (published by default); `fields` overrides frontmatter. */
function writeVal(dir: string, id: string, fields: Record<string, unknown>): void {
  writeRecord(dir, `wiki/value-reports/${id}.md`, {
    id,
    title: `VAL ${id}`,
    status: 'published',
    owner: 'x',
    created: '2026-01-01',
    updated: '2026-01-01',
    window_start: '2026-01-01',
    window_end: '2026-01-01',
    base_commit: 'aaaa',
    head_commit: 'bbbb',
    prior_val: 'none',
    chain_status: 'first',
    ...fields,
  });
}

describe('readPublishedPriors — cumulative-chain inputs from published VALs (WK-0058)', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('returns [] when there are no VAL records (a genuine first VAL)', () => {
    tmp = createTmpDir();
    expect(readPublishedPriors(tmp.dir)).toEqual([]);
  });

  it('collects replication_days + work_days from each published VAL, in id order', () => {
    tmp = createTmpDir();
    writeVal(tmp.dir, 'VAL-0001', { replication_days: 6, work_days: 2 });
    writeVal(tmp.dir, 'VAL-0002', { replication_days: 12, work_days: 3 });
    expect(readPublishedPriors(tmp.dir)).toEqual([
      { replication_days: 6, work_days: 2 },
      { replication_days: 12, work_days: 3 },
    ]);
  });

  it('excludes drafts — only published VALs feed the chain', () => {
    tmp = createTmpDir();
    writeVal(tmp.dir, 'VAL-0001', { replication_days: 6, work_days: 2 });
    writeVal(tmp.dir, 'VAL-0002', { status: 'draft', replication_days: 99, work_days: 1 });
    expect(readPublishedPriors(tmp.dir)).toEqual([{ replication_days: 6, work_days: 2 }]);
  });

  it('degrades to null when a published VAL predates the flat formula (no replication_days)', () => {
    // WHY: an old-format published VAL (human_days_* only) makes Σ replication_days unreadable — the
    // chain is optional, so the span still publishes but omits cum_leverage rather than summing junk.
    tmp = createTmpDir();
    writeVal(tmp.dir, 'VAL-0001', { replication_days: 6, work_days: 2 });
    writeVal(tmp.dir, 'VAL-0002', { speedup: 8.6 }); // no replication_days / work_days
    expect(readPublishedPriors(tmp.dir)).toBeNull();
  });
});

describe('finalizeValueReport — reads the chain from disk, then renders (WK-0058 tool entry)', () => {
  let tmp: TmpRepo;

  afterEach(() => tmp.cleanup());

  it('computes cum_leverage from the published prior on disk', () => {
    tmp = createTmpDir();
    writeVal(tmp.dir, 'VAL-0001', { replication_days: 6, work_days: 2 });
    const res = finalizeValueReport({
      dir: tmp.dir,
      metrics: makeMetrics({ review_units: GOLDEN_UNITS, work_days: 1 }),
      usage: makeUsage(),
      ratified: [{ path: 'tests/value-render.test.ts', ratified_days: 1.0 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.frontmatter.replication_days).toBe(2); // 1.0 (untouched) + 1.0 (adjusted)
    expect(res.data.cum_leverage).toBeCloseTo(8 / 3, 10); // (6 + 2) / (2 + 1)
  });

  it('degrades cum_leverage to null when the published chain is unreadable', () => {
    tmp = createTmpDir();
    writeVal(tmp.dir, 'VAL-0001', { speedup: 8.6 }); // old format, no replication_days
    const res = finalizeValueReport({
      dir: tmp.dir,
      metrics: makeMetrics({ review_units: GOLDEN_UNITS, work_days: 1 }),
      usage: makeUsage(),
      ratified: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.cum_leverage).toBeNull();
    expect(res.data.sections.roiLine).toContain('chain n/a');
  });

  it('propagates the path-key fail-loud from renderValueReport', () => {
    tmp = createTmpDir();
    const res = finalizeValueReport({
      dir: tmp.dir,
      metrics: makeMetrics({ review_units: GOLDEN_UNITS, work_days: 1 }),
      usage: makeUsage(),
      ratified: [{ path: 'ghost.ts', ratified_days: 1 }],
    });
    expect(res.ok).toBe(false);
  });
});

describe('rendered VAL lints 0/0 (WK-0058 acceptance)', () => {
  it('a VAL whose frontmatter + body come from finalizeValueReport passes lint with no errors', async () => {
    // WHY: the acceptance criterion — a VAL produced by the new surface must lint clean. Frontmatter
    // carries the raw finalize numerics; the body splices the tool's deterministic sections.
    const tmp = await createBootstrappedRepo('test/repo');
    try {
      const res = finalizeValueReport({
        dir: tmp.dir,
        metrics: makeMetrics({
          review_units: GOLDEN_UNITS,
          work_days: 1,
          cocomo_pm_nominal: 19.02,
          cocomo_kloc: 5.573,
        }),
        usage: makeUsage(),
        ratified: [{ path: 'tests/value-render.test.ts', ratified_days: 1.0 }],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const s = res.data.sections;
      const body = [
        '## Summary',
        '',
        'Test span for the lint acceptance check.',
        '',
        '## How This Was Calculated',
        '',
        s.howCalculated,
        '',
        '## Token Detail',
        '',
        s.tokenDetail,
        '',
        '## Agent Value',
        '',
        s.roiLine,
        '',
        s.ceilingLine,
        '',
      ].join('\n');

      writeRecord(
        tmp.dir,
        'wiki/value-reports/VAL-0001.md',
        {
          id: 'VAL-0001',
          title: 'Rendered VAL lint check',
          status: 'published',
          owner: 'x',
          created: '2026-08-10',
          updated: '2026-08-10',
          window_start: '2026-08-10',
          window_end: '2026-08-10',
          base_commit: 'aaaa',
          head_commit: 'bbbb',
          prior_val: 'none',
          chain_status: 'first',
          replication_days: res.data.frontmatter.replication_days,
          saved_floor_days: res.data.frontmatter.saved_floor_days,
          leverage: res.data.frontmatter.leverage,
          units_valued: res.data.frontmatter.units_valued,
        },
        body,
      );

      const lintRes = await lint({ dir: tmp.dir });
      expect(lintRes.ok).toBe(true);
      if (!lintRes.ok) return;
      const valDiags = lintRes.data.diagnostics.filter((d) => d.file.includes('VAL-0001'));
      expect(valDiags).toEqual([]); // the rendered VAL itself lints 0/0
    } finally {
      tmp.cleanup();
    }
  });
});
