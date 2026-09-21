/**
 * WK-0132 Slice 2 — derive a `code_review` HO from a delivered `implement` HO.
 *
 * Mechanical field derivation only (no judgment): reads the implement HO,
 * confirms it is mode=implement and delivered (response doc present), then
 * writes a new code_review HO whose fields are copied/derived from the
 * implement per the WK-0132 spec. Does NOT dispatch the review — the
 * orchestrator does that separately via the existing `dispatch` tool
 * (two-step review chain, ratified in WK-0132).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { allocate } from '@kb/wiki-core';

import { parseHandoff } from './ho.js';
import { renderHandoff } from './create-handoff.js';
import type { CreateHandoffOpts } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';

export interface DeriveReviewOpts {
  dir: string;
  handoff_id: string;
}

export interface DeriveReviewResult {
  reviewId: string;
  reviewPath: string;
  reviewRelativePath: string;
  implementId: string;
}

export async function deriveReview(opts: DeriveReviewOpts): Promise<DispatchResult<DeriveReviewResult>> {
  const targetDir = resolve(opts.dir);
  const implementRelativePath = `wiki/handoffs/${opts.handoff_id}.md`;
  const implementPath = join(targetDir, implementRelativePath);

  try {
    await readFile(implementPath, 'utf8');
  } catch {
    return fail('BAD_RECORD', `Implement HO not found: ${implementPath}`);
  }

  const parsed = await parseHandoff(implementPath);
  if (!parsed.ok) return parsed;
  const implement = parsed.data;

  if (implement.mode !== 'implement') {
    return fail('BAD_RECORD', `derive-review requires mode=implement; got ${implement.mode}`);
  }

  const responseRelativePath = `wiki/handoffs/${implement.id}.response.md`;
  const responsePath = join(targetDir, responseRelativePath);

  try {
    await readFile(responsePath, 'utf8');
  } catch {
    return fail('BAD_RECORD', `Implement HO ${implement.id} is not delivered (response doc missing)`);
  }

  const allocResult = await allocate({ dir: targetDir, prefix: 'HO' });
  if (!allocResult.ok) return fail('ALLOCATION_FAILED', allocResult.message);
  const reviewId = allocResult.data.id;

  const createOpts: CreateHandoffOpts = {
    dir: opts.dir,
    title: `Code review: ${implement.title}`,
    subject: implement.title,
    allowed_agents: ['*'],
    mode: 'code_review',
    work_item: implement.work_item,
    write_scope: [],
    read_first: [...implement.read_first, responseRelativePath],
    acceptance: implement.acceptance,
    validation: implement.validation,
    web: implement.web,
    credentials: implement.credentials,
    data_mounts: implement.data_mounts,
    export_mounts: implement.export_mounts,
    base_ref: `dispatch/${implement.id}`,
    vars: implement.vars,
  };

  const content = renderHandoff(reviewId, createOpts);
  const reviewRelativePath = `wiki/handoffs/${reviewId}.md`;
  const reviewPath = join(targetDir, reviewRelativePath);

  try {
    await writeFile(reviewPath, content, 'utf-8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write review handoff at ${reviewPath}.`, err);
  }

  return ok({
    reviewId,
    reviewPath,
    reviewRelativePath,
    implementId: implement.id,
  });
}
