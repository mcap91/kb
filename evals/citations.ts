/**
 * Row citation parsing and resolution (WK-0237 Resolutions 12 riders 1-2;
 * HO-0151 Constraints). Pure functions over a `## Resolutions` row's cells:
 * no process launch, no network, no model call. `parseCitations` reads only
 * `searched`/`evidence`; `resolveCitations` maps the parsed identifiers
 * through `contract/manifest.json`'s per-type `directory` (record ids) or
 * `testKbRoot` (repo-relative paths) and checks the result exists on disk.
 * `checkRowProse` is rider 2's separate presence check over `searched`,
 * `evidence` and `reason` -- those three cells never reach the judge.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ResolutionRow, WikiManifest } from '@kb/wiki-core';

export interface CitationIdentifiers {
  recordIds: string[];
  paths: string[];
  urls: string[];
}

const RECORD_ID_RE = /\b(?:WK|IN|DEC|SRC|PLN|VAL|AREA)-\d{4}\b/g;
const URL_RE = /\bhttps?:\/\/\S+/g;

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[),.;:'"\]]+$/, '');
}

function hasFileExtension(token: string): boolean {
  const lastSlash = token.lastIndexOf('/');
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= lastSlash + 1 || lastDot === token.length - 1) return false;
  return /^[A-Za-z0-9]{1,8}$/.test(token.slice(lastDot + 1));
}

/**
 * Parses `row.searched` and `row.evidence` only -- `reason` and every other
 * cell stay out of this, per Resolutions 12's "parsed by code from the row".
 * Returns the three identifier kinds the judge prompt (judge.ts) and
 * `resolveCitations` below consume: wiki record ids, repo-relative paths
 * (a token containing `/` with a file extension), and http(s) URLs.
 */
export function parseCitations(row: Pick<ResolutionRow, 'searched' | 'evidence'>): CitationIdentifiers {
  const text = `${row.searched} ${row.evidence}`;

  const urls = Array.from(new Set((text.match(URL_RE) ?? []).map(stripTrailingPunctuation)));
  const recordIds = Array.from(new Set(text.match(RECORD_ID_RE) ?? []));

  const textWithoutUrls = text.replace(URL_RE, ' ');
  const paths: string[] = [];
  for (const rawToken of textWithoutUrls.split(/\s+/)) {
    const token = stripTrailingPunctuation(rawToken);
    if (token.length === 0 || !token.includes('/')) continue;
    if (hasFileExtension(token)) paths.push(token);
  }

  return { recordIds, paths: Array.from(new Set(paths)), urls };
}

export interface ResolvedCitation {
  /** The record id or repo-relative path that resolved, as written in the row. */
  id: string;
  /** Its verified real path (`fs.realpathSync`), inside the real `testKbRoot` -- this is what gets read for the judge. */
  absolutePath: string;
}

export type CitationCheckReason = 'no-citation' | 'unresolved-citation' | 'outside-citation';

export type CitationCheckOutcome =
  | { passed: true; resolved: ResolvedCitation[] }
  | { passed: false; reason: 'unresolved-citation' | 'outside-citation'; identifier: string }
  | { passed: false; reason: 'no-citation' | 'outside-citation' };

type CandidateResolution = { ok: true; realPath: string } | { ok: false; reason: 'unresolved-citation' | 'outside-citation' };

/**
 * `existsSync` alone is lexical: a path lexically under `testKbRoot` can still
 * be a symlink resolving to a file outside it. This resolves the candidate's
 * real path with `fs.realpathSync` (wrapped -- a dangling symlink throws) and
 * checks containment against `realRoot`, `testKbRoot`'s own real path, so a
 * symlink escape fails `outside-citation` instead of silently passing.
 */
function resolveWithinRoot(absolutePath: string, realRoot: string): CandidateResolution {
  if (!existsSync(absolutePath)) return { ok: false, reason: 'unresolved-citation' };
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch {
    return { ok: false, reason: 'unresolved-citation' };
  }
  const rel = relative(realRoot, realPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: 'outside-citation' };
  }
  return { ok: true, realPath };
}

function resolveRecordId(id: string, testKbRoot: string, realRoot: string, manifest: WikiManifest): CandidateResolution {
  const prefix = id.split('-')[0];
  const typeEntry = Object.values(manifest.types).find((t) => t.prefix === prefix);
  if (!typeEntry) return { ok: false, reason: 'unresolved-citation' };
  const absolutePath = join(testKbRoot, typeEntry.directory, `${id}.md`);
  return resolveWithinRoot(absolutePath, realRoot);
}

function resolveRepoPath(path: string, testKbRoot: string, realRoot: string): CandidateResolution {
  const absolutePath = resolve(testKbRoot, path);
  const rel = relative(testKbRoot, absolutePath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: 'unresolved-citation' };
  }
  return resolveWithinRoot(absolutePath, realRoot);
}

/**
 * Maps `ids` through the manifest (record ids) and `testKbRoot` (repo paths),
 * requiring every parsed identifier to resolve to a file that exists inside
 * `testKbRoot` -- this is the code check Resolutions 12 rider 1 runs before
 * any judge call, so the judge never sees a dangling or outside citation. A
 * row with no identifier at all (every list empty) fails `no-citation`. Any
 * URL fails `outside-citation`: URLs point outside `testKbRoot` and are never
 * fetched, so their mere presence is disqualifying regardless of what else
 * resolved. Any record id or repo-relative path that does not resolve fails
 * `unresolved-citation`, naming the identifier. Containment is checked on
 * real paths (`fs.realpathSync`), not just lexical ones: a candidate that is
 * lexically under `testKbRoot` but a symlink resolving outside it fails
 * `outside-citation`, naming it, so the judge can never be handed an outside
 * file through a symlink. Only when every non-URL identifier resolves inside
 * the real root and no URL is present does this pass, returning every cited
 * file at its verified real path.
 */
export function resolveCitations(ids: CitationIdentifiers, testKbRoot: string, manifest: WikiManifest): CitationCheckOutcome {
  const totalIdentifiers = ids.recordIds.length + ids.paths.length + ids.urls.length;
  if (totalIdentifiers === 0) {
    return { passed: false, reason: 'no-citation' };
  }

  if (ids.urls.length > 0) {
    return { passed: false, reason: 'outside-citation' };
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(testKbRoot);
  } catch {
    return { passed: false, reason: 'unresolved-citation', identifier: testKbRoot };
  }

  const resolved: ResolvedCitation[] = [];

  for (const id of ids.recordIds) {
    const outcome = resolveRecordId(id, testKbRoot, realRoot, manifest);
    if (!outcome.ok) {
      return { passed: false, reason: outcome.reason, identifier: id };
    }
    resolved.push({ id, absolutePath: outcome.realPath });
  }
  for (const path of ids.paths) {
    const outcome = resolveRepoPath(path, testKbRoot, realRoot);
    if (!outcome.ok) {
      return { passed: false, reason: outcome.reason, identifier: path };
    }
    resolved.push({ id: path, absolutePath: outcome.realPath });
  }

  return { passed: true, resolved };
}

export type RowProseReason = 'missing-prose';
export type RowProseOutcome = { passed: true } | { passed: false; reason: RowProseReason };

/**
 * Resolutions 12 rider 2: `searched`, `evidence` and `reason` must each be
 * non-empty. A code check recorded separately from citation resolution --
 * these three cells never reach the judge regardless of this check's result.
 */
export function checkRowProse(row: Pick<ResolutionRow, 'searched' | 'evidence' | 'reason'>): RowProseOutcome {
  if (row.searched.trim().length === 0 || row.evidence.trim().length === 0 || row.reason.trim().length === 0) {
    return { passed: false, reason: 'missing-prose' };
  }
  return { passed: true };
}
