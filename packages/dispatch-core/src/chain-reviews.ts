/**
 * The reviews of a delivery chain, read from `wiki/handoffs/`: one lookup shared by
 * `merge-delivery` (judges every finished review's findings) and `derive-review` (reviews only
 * what no finished review has covered). Evidence is read from the response doc's
 * frontmatter, never re-parsed from its markdown.
 *
 * A review is FINISHED when its worker ran to completion and left a report: the response doc's
 * `outcome` is `delivered` and it holds a valid block or a non-empty report (`reviewState`); a doc
 * with none of the evidence stamps is not finished.
 * That one definition decides which review governs a merge, whose findings need judgments, and
 * which commits a later review skips.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { parseHandoffContent, type Handoff } from './ho.js';

const execFile = promisify(execFileCb);

/** The response doc `outcome` of a review run that ran to completion (capture.ts's `deriveVerdict`: a `code_review` that wrote a transcript). */
const COMPLETED_RUN_OUTCOME = 'delivered';

export interface ResponseDocEvidence {
  /** The run's mechanical outcome (`delivered`, `failed`, `refused`, ...), stamped by `writeResponseDoc` as `outcome`. */
  runOutcome: string | undefined;
  recoveryOutcome: string | undefined;
  recoveryValid: boolean | undefined;
  workerReportChars: number | undefined;
  /** The raw one-line JSON of `recovery_findings`; `undefined` when the line is absent. */
  recoveryFindings: string | undefined;
}

/**
 * Parse a response doc's YAML frontmatter for the fields capture.ts's
 * `writeResponseDoc` stamps: `outcome`, `recovery_outcome`, `recovery_valid`,
 * `worker_report_chars`. Mirrors the `---`-delimited split + line-oriented
 * `key: value` scan used elsewhere in this codebase (ho.ts's
 * `splitFrontmatter`/`parseFrontmatterYaml`, pipeline.ts's
 * `mergeProvenanceFrontmatter`), scoped to these scalars plus the raw `recovery_findings` line. A field
 * is `undefined` only when its line is entirely absent — distinct from an
 * empty string value, which means present-but-blank.
 */
export function parseResponseDocFrontmatter(content: string): ResponseDocEvidence {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { runOutcome: undefined, recoveryOutcome: undefined, recoveryValid: undefined, workerReportChars: undefined, recoveryFindings: undefined };
  }

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    fields[kvMatch[1]!] = (kvMatch[2] ?? '').trim();
  }

  return {
    runOutcome: fields.outcome,
    recoveryOutcome: fields.recovery_outcome,
    recoveryValid: fields.recovery_valid === undefined ? undefined : fields.recovery_valid === 'true',
    workerReportChars: fields.worker_report_chars === undefined ? undefined : Number.parseInt(fields.worker_report_chars, 10),
    recoveryFindings: fields.recovery_findings,
  };
}

/** The `base_ref` line of the frontmatter text of a handoff file that did not parse, or `undefined`. */
function frontmatterBaseRef(content: string): string | undefined {
  const frontmatter = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)(?:\n---|$)/)?.[1] ?? '';
  return frontmatter.match(/^base_ref:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
}

/**
 * Every `code_review` HO in `wiki/handoffs/`, parsed. A file that cannot be read or parsed is
 * skipped only when it cannot matter; one that names a branch of `chainBranches` as its `base_ref`
 * (it may be a review of the chain) is a failure, and so is any read error other than "not found" —
 * a review nobody can see must not change which review governs or which findings are judged.
 */
async function readCodeReviews(dir: string, chainBranches: ReadonlySet<string>): Promise<DispatchResult<Handoff[]>> {
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
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') continue;
      return fail('ADMISSION_FAILED', `Could not read handoff ${file}`, err);
    }
    const parsed = parseHandoffContent(content, file);
    if (!parsed.ok) {
      const baseRef = frontmatterBaseRef(content);
      if (baseRef !== undefined && chainBranches.has(baseRef)) {
        return fail(
          'ADMISSION_FAILED',
          `Handoff ${file} cannot be parsed (${parsed.message}) and names ${baseRef}, a branch of this chain, as its base_ref; it may be a review of this chain — fix or remove it`,
          parsed,
        );
      }
      continue;
    }
    if (parsed.data.mode === 'code_review') reviews.push(parsed.data);
  }
  return ok(reviews);
}

/** A review's response doc, or `null` when it has none; a read error other than "not found" is a failure. */
async function readResponseDoc(dir: string, reviewId: string): Promise<DispatchResult<string | null>> {
  try {
    return ok(await readFile(join(dir, 'wiki', 'handoffs', `${reviewId}.response.md`), 'utf8'));
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return ok(null);
    return fail('ADMISSION_FAILED', `Could not read review response doc ${reviewId}.response.md`, err);
  }
}

/** Where a review stands: `finished`, or why it is not. */
export type ReviewState = 'finished' | 'no response doc' | 'no evidence stamps' | 'empty report' | `run did not complete: ${string}`;

/**
 * A review is finished when its run completed (the response doc's `outcome` is `delivered`) and
 * the doc holds a valid block or a non-empty report. A doc with none of the block and report
 * fields carries no evidence to read, so it is not finished: no tool may treat it as a review that
 * covers the chain. A doc with no `outcome` line is judged on the block and report alone.
 */
function reviewState(responseDoc: string | null): ReviewState {
  if (responseDoc === null) return 'no response doc';
  const { runOutcome, recoveryOutcome, recoveryValid, workerReportChars } = parseResponseDocFrontmatter(responseDoc);
  if (runOutcome !== undefined && runOutcome !== COMPLETED_RUN_OUTCOME) return `run did not complete: ${runOutcome}`;
  if (recoveryOutcome === undefined && recoveryValid === undefined && workerReportChars === undefined) return 'no evidence stamps';
  return recoveryValid === true || (workerReportChars ?? 0) > 0 ? 'finished' : 'empty report';
}

export interface ChainReview {
  handoff: Handoff;
  /** The response doc text; `null` when the review has none. */
  doc: string | null;
  state: ReviewState;
}

/** Every `code_review` HO whose `base_ref` is a branch of `chainBranches`, with its response doc and state. */
export async function readChainReviews(dir: string, chainBranches: ReadonlySet<string>): Promise<DispatchResult<ChainReview[]>> {
  const reviews = await readCodeReviews(dir, chainBranches);
  if (!reviews.ok) return reviews;
  const chain: ChainReview[] = [];
  for (const handoff of reviews.data) {
    if (handoff.base_ref === null || !chainBranches.has(handoff.base_ref)) continue;
    const doc = await readResponseDoc(dir, handoff.id);
    if (!doc.ok) return doc;
    chain.push({ handoff, doc: doc.data, state: reviewState(doc.data) });
  }
  return ok(chain);
}

/** The chain's finished reviews that carry a `reviewed_sha` stamp, which a later review can build on. */
export async function readFinishedChainReviews(
  dir: string,
  chainBranches: ReadonlySet<string>,
): Promise<DispatchResult<(Handoff & { reviewed_sha: string })[]>> {
  const chain = await readChainReviews(dir, chainBranches);
  if (!chain.ok) return chain;
  const finished: (Handoff & { reviewed_sha: string })[] = [];
  for (const { handoff, state } of chain.data) {
    if (state === 'finished' && handoff.reviewed_sha !== undefined) finished.push({ ...handoff, reviewed_sha: handoff.reviewed_sha });
  }
  return ok(finished);
}

/**
 * Whether `sha` names a commit in the repository at `dir`. A stamp that was hand-edited, or whose
 * commit was pruned, is `false`; any other git failure is a failure.
 */
export async function commitExists(dir: string, sha: string): Promise<DispatchResult<boolean>> {
  try {
    await execFile('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`], { cwd: dir });
    return ok(true);
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return ok(false);
    return fail('BAD_RECORD', `Failed to look up ${sha} in ${dir}.`, err);
  }
}
