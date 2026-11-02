/**
 * WK-0237 slice B1b -- row citation parsing/resolution and the prose
 * presence check (Resolutions 12 riders 1-2; HO-0151 Constraints/Acceptance).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkRowProse, parseCitations, resolveCitations } from '../evals/citations.js';
import type { WikiManifest } from '@kb/wiki-core';

const MANIFEST = JSON.parse(
  readFileSync(join(__dirname, '..', 'contract', 'manifest.json'), 'utf8'),
) as WikiManifest;

let tmpDirs: string[] = [];

function makeTestKbRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kb-eval-citations-'));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('parseCitations', () => {
  it('extracts record ids, repo-relative paths and URLs from searched + evidence only', () => {
    const row = {
      searched: 'wiki (DEC-0901, services/billing/caller.ts); https://example.com/spec#s1',
      evidence: 'DEC-0901 settles this; also see docs/plan.md',
      reason: 'this reason text must never be scanned for citations',
    };
    const ids = parseCitations(row);
    expect(ids.recordIds).toEqual(['DEC-0901']);
    expect([...ids.paths].sort()).toEqual(['docs/plan.md', 'services/billing/caller.ts']);
    expect(ids.urls).toEqual(['https://example.com/spec#s1']);
  });

  it('returns empty lists when searched and evidence cite nothing', () => {
    const ids = parseCitations({ searched: 'nothing relevant found', evidence: 'no evidence available' });
    expect(ids).toEqual({ recordIds: [], paths: [], urls: [] });
  });

  it('ignores a record-id-shaped token in reason (reason is never read)', () => {
    const row = { searched: '', evidence: '', reason: 'cites DEC-0905 and services/other.ts' };
    const ids = parseCitations(row);
    expect(ids).toEqual({ recordIds: [], paths: [], urls: [] });
  });
});

describe('resolveCitations', () => {
  it('resolves a record id through the manifest directory', () => {
    const root = makeTestKbRoot();
    writeFile(root, 'wiki/decisions/DEC-0901.md', '# DEC-0901');
    const outcome = resolveCitations({ recordIds: ['DEC-0901'], paths: [], urls: [] }, root, MANIFEST);
    expect(outcome.passed).toBe(true);
    if (outcome.passed) {
      expect(outcome.resolved).toEqual([
        { id: 'DEC-0901', absolutePath: join(root, 'wiki/decisions/DEC-0901.md') },
      ]);
    }
  });

  it('resolves a repo-relative path under testKbRoot', () => {
    const root = makeTestKbRoot();
    writeFile(root, 'services/billing/caller.ts', 'export {};');
    const outcome = resolveCitations(
      { recordIds: [], paths: ['services/billing/caller.ts'], urls: [] },
      root,
      MANIFEST,
    );
    expect(outcome.passed).toBe(true);
    if (outcome.passed) {
      expect(outcome.resolved[0].absolutePath).toBe(join(root, 'services/billing/caller.ts'));
    }
  });

  it('fails no-citation when every identifier list is empty', () => {
    const root = makeTestKbRoot();
    const outcome = resolveCitations({ recordIds: [], paths: [], urls: [] }, root, MANIFEST);
    expect(outcome).toEqual({ passed: false, reason: 'no-citation' });
  });

  it('fails outside-citation for a URL-only row -- URLs are listed but never fetched', () => {
    const root = makeTestKbRoot();
    const outcome = resolveCitations({ recordIds: [], paths: [], urls: ['https://example.com/spec'] }, root, MANIFEST);
    expect(outcome).toEqual({ passed: false, reason: 'outside-citation' });
  });

  it('fails unresolved-citation, naming it, when a cited record id has no file on disk', () => {
    const root = makeTestKbRoot();
    const outcome = resolveCitations({ recordIds: ['DEC-9999'], paths: [], urls: [] }, root, MANIFEST);
    expect(outcome).toEqual({ passed: false, reason: 'unresolved-citation', identifier: 'DEC-9999' });
  });

  it('fails unresolved-citation, naming it, when a cited path does not exist under testKbRoot', () => {
    const root = makeTestKbRoot();
    const outcome = resolveCitations({ recordIds: [], paths: ['services/missing.ts'], urls: [] }, root, MANIFEST);
    expect(outcome).toEqual({ passed: false, reason: 'unresolved-citation', identifier: 'services/missing.ts' });
  });

  it('fails unresolved-citation when a cited path escapes testKbRoot, even if the target exists', () => {
    const root = makeTestKbRoot();
    const secretRoot = makeTestKbRoot();
    writeFile(secretRoot, 'secret.md', 'top secret');
    const escapingPath = relative(root, join(secretRoot, 'secret.md'));
    const outcome = resolveCitations({ recordIds: [], paths: [escapingPath], urls: [] }, root, MANIFEST);
    expect(outcome).toEqual({ passed: false, reason: 'unresolved-citation', identifier: escapingPath });
  });

  it('fails unresolved-citation, naming the missing id, when one id among several resolved identifiers does not resolve', () => {
    const root = makeTestKbRoot();
    writeFile(root, 'wiki/decisions/DEC-0901.md', '# DEC-0901');
    writeFile(root, 'services/billing/caller.ts', 'export {};');
    const outcome = resolveCitations(
      { recordIds: ['DEC-0901', 'DEC-9999'], paths: ['services/billing/caller.ts'], urls: [] },
      root,
      MANIFEST,
    );
    expect(outcome).toEqual({ passed: false, reason: 'unresolved-citation', identifier: 'DEC-9999' });
  });

  it('fails outside-citation when a URL is cited alongside otherwise-resolved files', () => {
    const root = makeTestKbRoot();
    writeFile(root, 'wiki/decisions/DEC-0901.md', '# DEC-0901');
    writeFile(root, 'services/billing/caller.ts', 'export {};');
    const outcome = resolveCitations(
      { recordIds: ['DEC-0901'], paths: ['services/billing/caller.ts'], urls: ['https://example.com'] },
      root,
      MANIFEST,
    );
    expect(outcome).toEqual({ passed: false, reason: 'outside-citation' });
  });

  it('passes and returns every cited file when every identifier resolves', () => {
    const root = makeTestKbRoot();
    writeFile(root, 'wiki/decisions/DEC-0901.md', '# DEC-0901');
    writeFile(root, 'services/billing/caller.ts', 'export {};');
    writeFile(root, 'docs/plan.md', '# plan');
    const outcome = resolveCitations(
      { recordIds: ['DEC-0901'], paths: ['services/billing/caller.ts', 'docs/plan.md'], urls: [] },
      root,
      MANIFEST,
    );
    expect(outcome.passed).toBe(true);
    if (outcome.passed) {
      expect([...outcome.resolved].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'DEC-0901', absolutePath: join(root, 'wiki/decisions/DEC-0901.md') },
        { id: 'docs/plan.md', absolutePath: join(root, 'docs/plan.md') },
        { id: 'services/billing/caller.ts', absolutePath: join(root, 'services/billing/caller.ts') },
      ]);
    }
  });
});

describe('checkRowProse', () => {
  it('passes when searched, evidence and reason are all non-empty', () => {
    expect(checkRowProse({ searched: 's', evidence: 'e', reason: 'r' }).passed).toBe(true);
  });

  it('fails when searched is empty', () => {
    expect(checkRowProse({ searched: '', evidence: 'e', reason: 'r' })).toEqual({
      passed: false,
      reason: 'missing-prose',
    });
  });

  it('fails when evidence is empty', () => {
    expect(checkRowProse({ searched: 's', evidence: '', reason: 'r' })).toEqual({
      passed: false,
      reason: 'missing-prose',
    });
  });

  it('fails when reason is whitespace-only', () => {
    expect(checkRowProse({ searched: 's', evidence: 'e', reason: '   ' })).toEqual({
      passed: false,
      reason: 'missing-prose',
    });
  });
});
