/**
 * The reviews of a delivery chain, read from `wiki/handoffs/`: one lookup shared by
 * `merge-delivery` (judges every review's findings) and `derive-review` (reviews only
 * what no finished review has covered). Evidence is read from the response doc's
 * frontmatter, never re-parsed from its markdown.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { parseHandoffContent, type Handoff } from './ho.js';

export interface ResponseDocEvidence {
  recoveryOutcome: string | undefined;
  recoveryValid: boolean | undefined;
  workerReportChars: number | undefined;
  /** The raw one-line JSON of `recovery_findings`; `undefined` when the line is absent. */
  recoveryFindings: string | undefined;
}

/**
 * Parse a response doc's YAML frontmatter for the three fields capture.ts's
 * `writeResponseDoc` stamps: `recovery_outcome`, `recovery_valid`,
 * `worker_report_chars`. Mirrors the `---`-delimited split + line-oriented
 * `key: value` scan used elsewhere in this codebase (ho.ts's
 * `splitFrontmatter`/`parseFrontmatterYaml`, pipeline.ts's
 * `mergeProvenanceFrontmatter`), scoped to these three scalars plus the raw `recovery_findings` line. A field
 * is `undefined` only when its line is entirely absent — distinct from an
 * empty string value, which means present-but-blank.
 */
export function parseResponseDocFrontmatter(content: string): ResponseDocEvidence {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { recoveryOutcome: undefined, recoveryValid: undefined, workerReportChars: undefined, recoveryFindings: undefined };
  }

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    fields[kvMatch[1]!] = (kvMatch[2] ?? '').trim();
  }

  return {
    recoveryOutcome: fields.recovery_outcome,
    recoveryValid: fields.recovery_valid === undefined ? undefined : fields.recovery_valid === 'true',
    workerReportChars: fields.worker_report_chars === undefined ? undefined : Number.parseInt(fields.worker_report_chars, 10),
    recoveryFindings: fields.recovery_findings,
  };
}

/** Every `code_review` HO in `wiki/handoffs/`, parsed; unreadable or unparsable files are skipped. */
export async function readCodeReviews(dir: string): Promise<DispatchResult<Handoff[]>> {
  const handoffsDir = join(dir, 'wiki', 'handoffs');

  let files: string[];
  try {
    files = await readdir(handoffsDir);
  } catch (err) {
    return fail('ADMISSION_FAILED', `Could not read handoffs directory: ${handoffsDir}`, err);
  }

  const reviews: Handoff[] = [];
  for (const file of files.filter((f) => /^HO-\d{4}\.md$/.test(f))) {
    let content: string;
    try {
      content = await readFile(join(handoffsDir, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseHandoffContent(content, file);
    if (parsed.ok && parsed.data.mode === 'code_review') reviews.push(parsed.data);
  }
  return ok(reviews);
}

/** Whether the review's response doc exists in `wiki/handoffs/`. */
export async function hasResponseDoc(dir: string, reviewId: string): Promise<boolean> {
  try {
    await readFile(join(dir, 'wiki', 'handoffs', `${reviewId}.response.md`), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The chain's finished reviews: `code_review` HOs based on one of `chainBranches`, stamped
 * with a `reviewed_sha`, whose response doc carries a non-empty report.
 */
export async function readFinishedChainReviews(
  dir: string,
  chainBranches: ReadonlySet<string>,
): Promise<DispatchResult<(Handoff & { reviewed_sha: string })[]>> {
  const reviews = await readCodeReviews(dir);
  if (!reviews.ok) return reviews;
  const finished: (Handoff & { reviewed_sha: string })[] = [];
  for (const review of reviews.data) {
    if (review.base_ref === null || !chainBranches.has(review.base_ref) || review.reviewed_sha === undefined) continue;
    let content: string;
    try {
      content = await readFile(join(dir, 'wiki', 'handoffs', `${review.id}.response.md`), 'utf8');
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') continue;
      return fail('ADMISSION_FAILED', `Could not read review response doc ${review.id}.response.md`, err);
    }
    const chars = parseResponseDocFrontmatter(content).workerReportChars;
    if (chars !== undefined && chars > 0) finished.push({ ...review, reviewed_sha: review.reviewed_sha });
  }
  return ok(finished);
}
