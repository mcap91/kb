/**
 * value-finalize.ts — the WK-0058 finalize tool entry.
 *
 * Wraps the pure `renderValueReport()` with the one piece of I/O it needs: reading prior PUBLISHED
 * VALs' {replication_days, work_days} off disk for the cumulative chain line. `renderValueReport`
 * stays pure (priors are an input); this module gathers them. The finalize is a DISTINCT tool from
 * value-report (operator-approved 2026-08-10): measure and render are separate phases with different
 * inputs and timing (render consumes operator-ratified rows that do not exist at measure time).
 *
 * Rules: Result<T> where fallible; never throw.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Result } from './errors.js';
import { readValFrontmatter } from './value-report.js';
import { renderValueReport } from './value-render.js';
import type { RenderedVal, PriorValNumbers, RatifiedRow } from './value-render.js';
import type { ValueMetrics, UsageMetrics } from './types.js';

/**
 * Read prior PUBLISHED VALs' {replication_days, work_days} from `wiki/value-reports/` — the
 * cumulative-chain inputs. Returns `[]` for a genuine first VAL (no published priors). Returns
 * `null` when a published VAL predates the flat formula (missing/unparseable replication_days or
 * work_days): the chain is then unreadable and cum_leverage degrades (WK-0058: the chain is
 * optional — the span still publishes). Drafts are excluded — the watermark advances only on publish.
 */
export function readPublishedPriors(dir: string): PriorValNumbers[] | null {
  const valDir = path.join(dir, 'wiki', 'value-reports');
  if (!fs.existsSync(valDir)) return [];

  const files = fs
    .readdirSync(valDir)
    .filter((f) => f.endsWith('.md') && /^VAL-\d+\.md$/.test(f))
    .sort();

  const priors: PriorValNumbers[] = [];
  for (const file of files) {
    const fm = readValFrontmatter(path.join(valDir, file));
    if (!fm || fm.status !== 'published') continue; // only published VALs feed the chain
    const replication_days = Number(fm.replication_days);
    const work_days = Number(fm.work_days);
    if (!Number.isFinite(replication_days) || !Number.isFinite(work_days)) {
      return null; // an unreadable published link makes the whole cumulative chain unreadable
    }
    priors.push({ replication_days, work_days });
  }
  return priors;
}

/** Inputs to the finalize: the target repo + the frozen tool JSON + operator ratifications. */
export interface FinalizeValueReportOpts {
  dir: string;
  metrics: ValueMetrics;
  usage: UsageMetrics;
  ratified: RatifiedRow[];
}

/**
 * The value-finalize entry: gather the published chain from disk, then render the deterministic VAL
 * body via `renderValueReport()`. Returns `Result<RenderedVal>` — the display sections + raw
 * frontmatter numerics the agent writes into the record. Never throws; the path-key fail-loud
 * (a ratified path absent from review_units) propagates from the render.
 */
export function finalizeValueReport(opts: FinalizeValueReportOpts): Result<RenderedVal> {
  const priors = readPublishedPriors(opts.dir);
  return renderValueReport({
    metrics: opts.metrics,
    usage: opts.usage,
    ratified: opts.ratified,
    priors,
  });
}
