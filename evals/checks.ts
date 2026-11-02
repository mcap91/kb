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

export type CheckOutcome = { passed: true } | { passed: false; reason: string };

export interface CheckContext {
  log: ParsedStreamLog;
  diffText: string;
  scenario: Scenario;
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

function isTableRowOrBlankLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || (trimmed.startsWith('|') && trimmed.endsWith('|'));
}

export function checkWikiEditOnlyResolutions(diffText: string, scenario: Scenario): CheckOutcome {
  const changes = parseGitDiff(diffText);
  const targetPath = `wiki/issues/${scenario.target_wk}.md`;

  const wikiChanges = changes.filter((c) => isUnderWiki(c.path) && c.path !== SEARCH_INDEX_PATH);
  const offTarget = wikiChanges.filter((c) => c.path !== targetPath);
  if (offTarget.length > 0) {
    return {
      passed: false,
      reason: `change(s) under wiki/ outside the target WK file: ${offTarget.map((c) => c.path).join(', ')}`,
    };
  }

  const targetChange = wikiChanges.find((c) => c.path === targetPath);
  if (!targetChange) {
    return { passed: false, reason: `no change found to ${targetPath}` };
  }

  if (targetChange.removedLines.length > 0) {
    return { passed: false, reason: `${targetPath} has removed line(s); not an append-only Resolutions edit` };
  }

  const badAdds = targetChange.addedLines.filter((l) => !isTableRowOrBlankLine(l));
  if (badAdds.length > 0) {
    return { passed: false, reason: `${targetPath} has a non-table-row addition: ${JSON.stringify(badAdds[0])}` };
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
      return ok(checkWikiEditOnlyResolutions(ctx.diffText, ctx.scenario));
    case 'no-denied-tool':
      return ok(checkNoDeniedTool(ctx.log));
    case 'no-kb-wiki-call':
      return ok(checkNoKbWikiCall(ctx.log));
    default:
      return fail('UNKNOWN_CHECK_KIND', `unknown check kind: ${String(kind)}`);
  }
}
