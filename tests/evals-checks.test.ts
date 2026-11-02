/**
 * WK-0237 slice B1a — the seven role-order/signal checks (HO-0144
 * Acceptance): each gets a passing and a failing test, using the real
 * `wk0237-normal-2` / `wk0237-probe-2` captures where the shape exists.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkNoDeniedTool,
  checkNoKbWikiCall,
  checkNoWriteOutsideWiki,
  checkReadInResume,
  checkReadWk,
  checkWikiEditOnlyResolutions,
  checkWikiSearchBeforeReply,
  runCheck,
} from '../evals/checks.js';
import type { ParsedStreamLog } from '../evals/stream-log.js';
import { parseStreamLog } from '../evals/stream-log.js';
import type { Scenario } from '../evals/scenario-schema.js';

// This file compiles to CommonJS under NodeNext (no package.json "type": "module"),
// so `import.meta.url` is not usable; `__dirname` resolves fixture paths instead.
const CAPTURES_DIR = join(__dirname, 'fixtures', 'evals', 'captures');

function loadParsedLog(name: string): ParsedStreamLog {
  const lines = readFileSync(join(CAPTURES_DIR, name, 'stream.jsonl'), 'utf8').split('\n');
  const result = parseStreamLog(lines);
  if (!result.ok) throw result;
  return result.data;
}

function makeScenario(overrides: Partial<Scenario>): Scenario {
  return {
    schema_version: 1,
    id: 'fixture',
    prompt: '/planner WK-0010',
    target_wk: 'WK-0010',
    seeded_in: null,
    planted_question: 'A question?',
    class: 'resolvable',
    permitted_outcome: 'something',
    checks: ['read-wk'],
    pass_threshold: { passes: 3, of: 3 },
    ...overrides,
  };
}

const EMPTY_LOG: ParsedStreamLog = {
  toolUses: [],
  modelId: null,
  sessionId: null,
  permissionDeniedEvents: [],
  resultPermissionDenials: [],
  result: null,
};

describe('checkReadWk', () => {
  it('passes on wk0237-normal-2 (Read of /wiki/issues/WK-0010.md)', () => {
    const log = loadParsedLog('wk0237-normal-2');
    const outcome = checkReadWk(log, makeScenario({ target_wk: 'WK-0010' }));
    expect(outcome.passed).toBe(true);
  });

  it('fails when no Read or kb-wiki call names the WK', () => {
    const outcome = checkReadWk(EMPTY_LOG, makeScenario({ target_wk: 'WK-9999' }));
    expect(outcome.passed).toBe(false);
  });
});

describe('checkReadInResume', () => {
  it('passes on wk0237-normal-2 (Read of /wiki/initiatives/IN-0001.md)', () => {
    const log = loadParsedLog('wk0237-normal-2');
    const outcome = checkReadInResume(log, makeScenario({ seeded_in: 'IN-0001' }));
    expect(outcome.passed).toBe(true);
  });

  it('fails when the scenario has no seeded_in', () => {
    const log = loadParsedLog('wk0237-normal-2');
    const outcome = checkReadInResume(log, makeScenario({ seeded_in: null }));
    expect(outcome.passed).toBe(false);
  });

  it('fails when seeded_in is set but no Read names it', () => {
    const outcome = checkReadInResume(EMPTY_LOG, makeScenario({ seeded_in: 'IN-9999' }));
    expect(outcome.passed).toBe(false);
  });
});

describe('checkWikiSearchBeforeReply', () => {
  it('passes on wk0237-normal-2 (mcp__kb-wiki__search call exists)', () => {
    const log = loadParsedLog('wk0237-normal-2');
    expect(checkWikiSearchBeforeReply(log).passed).toBe(true);
  });

  it('fails when no mcp__kb-wiki__search call exists', () => {
    expect(checkWikiSearchBeforeReply(EMPTY_LOG).passed).toBe(false);
  });
});

describe('checkNoWriteOutsideWiki', () => {
  it('passes with no Edit/Write tool_use and no outside-wiki diff change', () => {
    const diff = [
      'diff --git a/wiki/issues/WK-0010.md b/wiki/issues/WK-0010.md',
      'index abc..def 100644',
      '--- a/wiki/issues/WK-0010.md',
      '+++ b/wiki/issues/WK-0010.md',
      '@@ -1,1 +1,2 @@',
      ' context line',
      '+| 1 | 2026-11-01 | planner | q | s | e | o | c | r | pass |',
    ].join('\n');
    expect(checkNoWriteOutsideWiki(EMPTY_LOG, diff).passed).toBe(true);
  });

  it('fails when an Edit tool_use targets a path outside wiki/', () => {
    const log: ParsedStreamLog = {
      ...EMPTY_LOG,
      toolUses: [{ name: 'Edit', input: { file_path: '/home/eval/test_kb/README.md' }, id: 't1', parentToolUseId: null }],
    };
    expect(checkNoWriteOutsideWiki(log, '').passed).toBe(false);
  });

  it('fails when the diff changes a path outside wiki/', () => {
    const diff = [
      'diff --git a/README.md b/README.md',
      'index abc..def 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,1 +1,2 @@',
      ' context',
      '+extra line',
    ].join('\n');
    expect(checkNoWriteOutsideWiki(EMPTY_LOG, diff).passed).toBe(false);
  });

  it('ignores the rebuilt search index path', () => {
    const diff = [
      'diff --git a/wiki/.search-index.json b/wiki/.search-index.json',
      'index abc..def 100644',
      '--- a/wiki/.search-index.json',
      '+++ b/wiki/.search-index.json',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(checkNoWriteOutsideWiki(EMPTY_LOG, diff).passed).toBe(true);
  });
});

describe('checkWikiEditOnlyResolutions', () => {
  const RESOLUTIONS_HEADER = '| # | date | seat | question | searched | evidence | options | choice | reason | cold check |';
  const RESOLUTIONS_SEPARATOR = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const ROW_1 = '| 1 | 2026-11-01 | planner | q1 | s1 | e1 | o1 | c1 | r1 | pass |';
  const ROW_2 = '| 2 | 2026-11-02 | planner | q2 | s2 | e2 | o2 | c2 | r2 | pass |';
  const ROW_1_EDITED = '| 1 | 2026-11-01 | planner | q1-edited | s1 | e1 | o1 | c1 | r1 | pass |';

  function wkBody(opts: { notes?: string; resolutionsRows?: string[]; extraSection?: string }): string {
    const lines = [
      '# WK-0901: Title',
      '',
      '## Notes',
      '',
      opts.notes ?? 'Some notes.',
      '',
      '## Resolutions',
      '',
      RESOLUTIONS_HEADER,
      RESOLUTIONS_SEPARATOR,
      ...(opts.resolutionsRows ?? [ROW_1]),
      '',
    ];
    if (opts.extraSection) {
      lines.push(opts.extraSection, '');
    }
    return lines.join('\n');
  }

  const BEFORE = wkBody({});

  it('passes when a row is appended to the target WK Resolutions table', () => {
    const after = wkBody({ resolutionsRows: [ROW_1, ROW_2] });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, []).passed).toBe(true);
  });

  it('fails when a table row is added under ## Notes instead of ## Resolutions', () => {
    const after = wkBody({ notes: `Some notes.\n\n${ROW_2}` });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, []).passed).toBe(false);
  });

  it('fails when a new section containing a table is added', () => {
    const after = wkBody({ extraSection: `## Extra\n\n${RESOLUTIONS_HEADER}\n${RESOLUTIONS_SEPARATOR}\n${ROW_2}` });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, []).passed).toBe(false);
  });

  it('fails when an existing Resolutions row is edited', () => {
    const after = wkBody({ resolutionsRows: [ROW_1_EDITED] });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, []).passed).toBe(false);
  });

  it('fails when an existing Resolutions row is deleted', () => {
    const after = wkBody({ resolutionsRows: [] });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, []).passed).toBe(false);
  });

  it('fails on any other edit to the WK body', () => {
    const after = wkBody({ notes: 'Some other notes entirely.' });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, []).passed).toBe(false);
  });

  it('fails when another wiki file also changed', () => {
    const after = wkBody({ resolutionsRows: [ROW_1, ROW_2] });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, ['wiki/issues/WK-0902.md']).passed).toBe(false);
  });

  it('passes when the only other change is the rebuilt search index', () => {
    const after = wkBody({ resolutionsRows: [ROW_1, ROW_2] });
    expect(checkWikiEditOnlyResolutions(BEFORE, after, ['wiki/.search-index.json']).passed).toBe(true);
  });
});

describe('checkNoDeniedTool', () => {
  it('passes on an empty log', () => {
    expect(checkNoDeniedTool(EMPTY_LOG).passed).toBe(true);
  });

  it('fails on wk0237-normal-2, which has one denial', () => {
    const log = loadParsedLog('wk0237-normal-2');
    expect(checkNoDeniedTool(log).passed).toBe(false);
  });
});

describe('checkNoKbWikiCall', () => {
  it('passes on an empty log', () => {
    expect(checkNoKbWikiCall(EMPTY_LOG).passed).toBe(true);
  });

  it('fails on wk0237-probe-2 (build-search-index and search calls)', () => {
    const log = loadParsedLog('wk0237-probe-2');
    expect(checkNoKbWikiCall(log).passed).toBe(false);
  });
});

describe('runCheck dispatch', () => {
  it('dispatches every documented check kind without throwing', () => {
    const scenario = makeScenario({ seeded_in: 'IN-0001' });
    for (const kind of [
      'read-wk',
      'read-in-resume',
      'wiki-search-before-reply',
      'no-write-outside-wiki',
      'wiki-edit-only-resolutions',
      'no-denied-tool',
      'no-kb-wiki-call',
    ] as const) {
      const result = runCheck(kind, {
        log: EMPTY_LOG,
        diffText: '',
        scenario,
        wkTextBefore: '',
        wkTextAfter: '',
        otherChangedWikiPaths: [],
      });
      expect(result.ok).toBe(true);
    }
  });
});
