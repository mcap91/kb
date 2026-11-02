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
import { existsSync } from 'node:fs';
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
  /** Its resolved absolute path inside `testKbRoot`. */
  absolutePath: string;
}

export type CitationCheckReason = 'no-citation' | 'unresolved-citation';

export type CitationCheckOutcome =
  | { passed: true; resolved: ResolvedCitation[] }
  | { passed: false; reason: CitationCheckReason };

function resolveRecordId(id: string, testKbRoot: string, manifest: WikiManifest): string | null {
  const prefix = id.split('-')[0];
  const typeEntry = Object.values(manifest.types).find((t) => t.prefix === prefix);
  if (!typeEntry) return null;
  const absolutePath = join(testKbRoot, typeEntry.directory, `${id}.md`);
  return existsSync(absolutePath) ? absolutePath : null;
}

function resolveRepoPath(path: string, testKbRoot: string): string | null {
  const absolutePath = resolve(testKbRoot, path);
  const rel = relative(testKbRoot, absolutePath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return existsSync(absolutePath) ? absolutePath : null;
}

/**
 * Maps `ids` through the manifest (record ids) and `testKbRoot` (repo paths),
 * keeping only identifiers that resolve to a file that exists inside
 * `testKbRoot`. URLs are listed in `ids.urls` but never resolved or fetched,
 * so a row citing only URLs has zero resolved identifiers and fails
 * `unresolved-citation`, same as a row whose record id or path cites nothing
 * that exists. A row with no identifier at all (every list empty) fails
 * `no-citation` instead -- this is the code check Resolutions 12 rider 1 runs
 * before any judge call.
 */
export function resolveCitations(ids: CitationIdentifiers, testKbRoot: string, manifest: WikiManifest): CitationCheckOutcome {
  const totalIdentifiers = ids.recordIds.length + ids.paths.length + ids.urls.length;
  if (totalIdentifiers === 0) {
    return { passed: false, reason: 'no-citation' };
  }

  const resolved: ResolvedCitation[] = [];

  for (const id of ids.recordIds) {
    const absolutePath = resolveRecordId(id, testKbRoot, manifest);
    if (absolutePath !== null) resolved.push({ id, absolutePath });
  }
  for (const path of ids.paths) {
    const absolutePath = resolveRepoPath(path, testKbRoot);
    if (absolutePath !== null) resolved.push({ id: path, absolutePath });
  }

  if (resolved.length === 0) {
    return { passed: false, reason: 'unresolved-citation' };
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
