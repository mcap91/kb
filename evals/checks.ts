/**
 * The seven role-order/signal check kinds (WK-0237 Resolutions 4, scope
 * 15.5's install list, HO-0144 Constraints), each a pure function over
 * (parsed log, saved git diff text, scenario). `runCheck` is the uniform
 * entry point the slice B1b pipeline dispatches through.
 *
 * Capture facts: `wk0237-normal-2` line 16 is a `Read` tool_use with
 * `input.file_path` `/home/eval/test_kb/wiki/issues/WK-0010.md` (read-wk);
 * line 8 is an `mcp__kb-wiki__search` tool_use with `input.query: "WK-0010"`
 * (read-wk's kb-wiki alternative, and wiki-search-before-reply); line 18 is
 * a `Read` of `/home/eval/test_kb/wiki/initiatives/IN-0001.md`
 * (read-in-resume); line 30 is the one `system`/`permission_denied` event
 * normal-2 carries, so `no-denied-tool` fails on it as required.
 * `wk0237-probe-2` lines 42/45 are `mcp__kb-wiki__build-search-index` and
 * `mcp__kb-wiki__search` tool_uses, so `no-kb-wiki-call` fails on it as
 * required.
 */
import type { CheckKind, Scenario } from './scenario-schema.js';
import { fail, ok, type EvalResult } from './result.js';
import { changedPathsOutsideWiki, isUnderWiki, parseGitDiff, SEARCH_INDEX_PATH } from './diff.js';
import type { ParsedStreamLog, ToolUse } from './stream-log.js';
import { readResolutions, type ResolutionRow } from '@kb/wiki-core';

export type CheckOutcome = { passed: true } | { passed: false; reason: string };

export interface CheckContext {
  log: ParsedStreamLog;
  diffText: string;
  scenario: Scenario;
  /** Target WK's full body text before the run (HO-0148; B1b supplies the real value). */
  wkTextBefore: string;
  /** Target WK's full body text after the run (HO-0148; B1b supplies the real value). */
  wkTextAfter: string;
  /** Changed wiki paths other than the target WK's, including the search index if it changed. */
  otherChangedWikiPaths: string[];
}

function readFilePath(toolUse: ToolUse): string | undefined {
  const input = toolUse.input as Record<string, unknown> | undefined;
  const path = input?.file_path;
  return typeof path === 'string' ? path : undefined;
}

function toolInputContains(input: unknown, needle: string): boolean {
  try {
    return JSON.stringify(input).includes(needle);
  } catch {
    return false;
  }
}

export function checkReadWk(log: ParsedStreamLog, scenario: Scenario): CheckOutcome {
  const wkId = scenario.target_wk;
  const readHit = log.toolUses.some((t) => t.name === 'Read' && (readFilePath(t) ?? '').includes(wkId));
  const wikiHit = log.toolUses.some((t) => t.name.startsWith('mcp__kb-wiki__') && toolInputContains(t.input, wkId));
  if (readHit || wikiHit) return { passed: true };
  return { passed: false, reason: `no Read of a path containing ${wkId}, and no mcp__kb-wiki__* call naming ${wkId}` };
}

export function checkReadInResume(log: ParsedStreamLog, scenario: Scenario): CheckOutcome {
  if (scenario.seeded_in === null) {
    return { passed: false, reason: 'scenario has no seeded_in; read-in-resume is not applicable' };
  }
  const inId = scenario.seeded_in;
  const hit = log.toolUses.some((t) => t.name === 'Read' && (readFilePath(t) ?? '').includes(inId));
  if (hit) return { passed: true };
  return { passed: false, reason: `no Read of a path containing ${inId}` };
}

export function checkWikiSearchBeforeReply(log: ParsedStreamLog): CheckOutcome {
  const hit = log.toolUses.some((t) => t.name === 'mcp__kb-wiki__search');
  if (hit) return { passed: true };
  return { passed: false, reason: 'no mcp__kb-wiki__search tool_use found' };
}

export function checkNoWriteOutsideWiki(log: ParsedStreamLog, diffText: string): CheckOutcome {
  const badTool = log.toolUses.find((t) => {
    if (t.name !== 'Edit' && t.name !== 'Write') return false;
    const path = readFilePath(t);
    return path !== undefined && !isUnderWiki(path);
  });
  if (badTool) {
    return { passed: false, reason: `${badTool.name} tool_use outside wiki/: ${readFilePath(badTool)}` };
  }

  const outside = changedPathsOutsideWiki(parseGitDiff(diffText));
  if (outside.length > 0) {
    return { passed: false, reason: `diff changes path(s) outside wiki/: ${outside.join(', ')}` };
  }

  return { passed: true };
}

/**
 * Removes the `## Resolutions` table's data rows (keeping the header and
 * separator rows) from `body`, leaving everything else untouched. Mirrors
 * body-table.ts's section/table-line detection (HO-0148) without importing
 * its unexported helpers.
 */
function stripResolutionsDataRows(body: string): string {
  const headingRe = /^##\s+Resolutions\s*$/m;
  const match = headingRe.exec(body);
  if (!match) return body;

  const sectionStart = match.index + match[0].length;
  const nextHeadingOffset = body.slice(sectionStart).indexOf('\n## ');
  const sectionEnd = nextHeadingOffset === -1 ? body.length : sectionStart + nextHeadingOffset;

  const section = body.slice(sectionStart, sectionEnd);
  let tableLineCount = 0;
  const kept: string[] = [];
  for (const line of section.split('\n')) {
    if (line.trim().startsWith('|')) {
      tableLineCount++;
      if (tableLineCount <= 2) kept.push(line);
    } else {
      kept.push(line);
    }
  }

  return body.slice(0, sectionStart) + kept.join('\n') + body.slice(sectionEnd);
}

function resolutionRowsEqual(a: ResolutionRow, b: ResolutionRow): boolean {
  return (
    a.num === b.num &&
    a.date === b.date &&
    a.seat === b.seat &&
    a.question === b.question &&
    a.searched === b.searched &&
    a.evidence === b.evidence &&
    a.options === b.options &&
    a.choice === b.choice &&
    a.reason === b.reason &&
    a.coldCheck === b.coldCheck
  );
}

/**
 * Passes only when the target WK's `## Resolutions` table gained rows
 * append-only and nothing else in the wiki changed (HO-0148, tightening
 * HO-0147's finding that any table-row-shaped diff addition anywhere in the
 * WK used to pass).
 */
export function checkWikiEditOnlyResolutions(
  wkTextBefore: string,
  wkTextAfter: string,
  otherChangedWikiPaths: string[],
): CheckOutcome {
  const otherPaths = otherChangedWikiPaths.filter((p) => p !== SEARCH_INDEX_PATH);
  if (otherPaths.length > 0) {
    return {
      passed: false,
      reason: `wiki path(s) other than the target WK changed: ${otherPaths.join(', ')}`,
    };
  }

  if (stripResolutionsDataRows(wkTextBefore) !== stripResolutionsDataRows(wkTextAfter)) {
    return { passed: false, reason: 'WK body changed outside the ## Resolutions table data rows' };
  }

  const beforeResult = readResolutions(wkTextBefore);
  if (!beforeResult.ok) {
    return { passed: false, reason: `before text's ## Resolutions table failed to parse: ${beforeResult.message}` };
  }
  const afterResult = readResolutions(wkTextAfter);
  if (!afterResult.ok) {
    return { passed: false, reason: `after text's ## Resolutions table failed to parse: ${afterResult.message}` };
  }

  const beforeRows = beforeResult.data;
  const afterRows = afterResult.data;
  if (afterRows.length < beforeRows.length) {
    return { passed: false, reason: '## Resolutions table has fewer rows after the run than before' };
  }
  for (let i = 0; i < beforeRows.length; i++) {
    if (!resolutionRowsEqual(beforeRows[i], afterRows[i])) {
      return {
        passed: false,
        reason: `## Resolutions row ${i + 1} changed; edits to existing rows are not append-only`,
      };
    }
  }

  return { passed: true };
}

export function checkNoDeniedTool(log: ParsedStreamLog): CheckOutcome {
  if (log.permissionDeniedEvents.length === 0 && log.resultPermissionDenials.length === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: `${log.permissionDeniedEvents.length} permission_denied event(s), ${log.resultPermissionDenials.length} result.permission_denials entry/entries`,
  };
}

export function checkNoKbWikiCall(log: ParsedStreamLog): CheckOutcome {
  const hit = log.toolUses.find((t) => t.name.startsWith('mcp__kb-wiki__'));
  if (!hit) return { passed: true };
  return { passed: false, reason: `mcp__kb-wiki__* call found: ${hit.name}` };
}

/** Dispatches one check kind against (parsed log, diff text, scenario); never throws. */
export function runCheck(kind: CheckKind, ctx: CheckContext): EvalResult<CheckOutcome> {
  switch (kind) {
    case 'read-wk':
      return ok(checkReadWk(ctx.log, ctx.scenario));
    case 'read-in-resume':
      return ok(checkReadInResume(ctx.log, ctx.scenario));
    case 'wiki-search-before-reply':
      return ok(checkWikiSearchBeforeReply(ctx.log));
    case 'no-write-outside-wiki':
      return ok(checkNoWriteOutsideWiki(ctx.log, ctx.diffText));
    case 'wiki-edit-only-resolutions':
      return ok(checkWikiEditOnlyResolutions(ctx.wkTextBefore, ctx.wkTextAfter, ctx.otherChangedWikiPaths));
    case 'no-denied-tool':
      return ok(checkNoDeniedTool(ctx.log));
    case 'no-kb-wiki-call':
      return ok(checkNoKbWikiCall(ctx.log));
    default:
      return fail('UNKNOWN_CHECK_KIND', `unknown check kind: ${String(kind)}`);
  }
}
