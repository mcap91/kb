/**
 * Structured review response header parser (PLN-0004 S6a, ruling 3 —
 * `wiki/plans/PLN-0004/execution/s6-rulings.md`). AgentChassis-mirror
 * adoption: the DESIGN of a structured, machine-checkable reviewer verdict is
 * mirrored (ELv2 — design only, never code); this parser is fresh kb code.
 *
 * A `code_review` worker's response begins with a YAML-like header block
 * between `---` delimiters carrying an outcome enum, per-finding
 * severity/blocking, and per-acceptance-criterion pass/fail. Ruling 3's
 * contract: **the header parses deterministically or the run is `failed`** —
 * prose is never authority, and outcome is never inferred from narrative.
 * That is why this module has no fallback path that scans the free-form body
 * for words like "pass" — a header that doesn't parse, or that fails
 * cross-field validation, is a hard `REVIEW_PARSE_FAILED`, full stop. The
 * eventual orchestration merge rule (§10) becomes mechanical downstream of
 * this: merge iff `outcome === 'pass'`.
 *
 * Line-based state-machine parser, consistent with this codebase's other
 * hand-rolled small-schema readers (`ho.ts`'s frontmatter reader, `pi.ts`'s
 * `## Needs` extractor, `delivery.ts`'s marker sections) — no YAML library,
 * because the schema is small and fixed:
 *
 * ```
 * ---
 * outcome: changes-requested
 * findings:
 *   - id: F1
 *     severity: high
 *     blocking: true
 *     summary: "Missing null check on line 42"
 *     detail: "optional longer explanation"
 *     ac: AC-2
 * acceptance_criteria:
 *   - criterion: "AC-1: parses valid header"
 *     pass: true
 *     notes: "optional"
 * ---
 * ```
 */
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

export type ReviewOutcome = 'pass' | 'pass-with-minor' | 'changes-requested';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  blocking: boolean;
  summary: string;
  detail?: string;
  ac?: string;
}

export interface ACResult {
  criterion: string;
  pass: boolean;
  notes?: string;
}

export interface StructuredReviewResult {
  outcome: ReviewOutcome;
  findings: ReviewFinding[];
  acceptanceCriteria: ACResult[];
}

const REVIEW_OUTCOMES: readonly ReviewOutcome[] = ['pass', 'pass-with-minor', 'changes-requested'];
const FINDING_SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function isReviewOutcome(value: string): value is ReviewOutcome {
  return (REVIEW_OUTCOMES as readonly string[]).includes(value);
}

function isFindingSeverity(value: string): value is FindingSeverity {
  return (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Accepts `true`/`false`/`yes`/`no`, case-insensitive (the one explicitly
 * case-insensitive rule in the spec — `outcome`/`severity` enum matching
 * below is deliberately exact-case, since nothing in ruling 3 calls for
 * folding those).
 */
function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === 'no') return false;
  return undefined;
}

/** Splits a `key: value` line on the FIRST colon only, so values may contain colons of their own. */
function parseKeyValue(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  let value = line.slice(idx + 1).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  return { key, value };
}

/**
 * Extracts the lines strictly between the first `---` delimiter (which must
 * appear within the first 5 lines — blank/whitespace lines before it are
 * tolerated, they just count against that budget) and the next `---`.
 * Anything after the closing delimiter (the free-form findings prose) is not
 * this function's concern.
 */
function extractHeaderBlock(responseText: string): DispatchResult<string[]> {
  const allLines = responseText.split('\n').map((line) => line.replace(/\r$/, ''));

  const searchWindow = Math.min(5, allLines.length);
  let startIdx = -1;
  for (let i = 0; i < searchWindow; i++) {
    if (allLines[i]!.trim() === '---') {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return fail(
      'REVIEW_PARSE_FAILED',
      `No opening '---' header delimiter found in the first ${searchWindow} line(s) of the response.`,
    );
  }

  let endIdx = -1;
  for (let i = startIdx + 1; i < allLines.length; i++) {
    if (allLines[i]!.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return fail(
      'REVIEW_PARSE_FAILED',
      "No closing '---' header delimiter found after the opening delimiter.",
    );
  }

  return ok(allLines.slice(startIdx + 1, endIdx));
}

/** Fields collected off a single `  - ...` array item, before typed/validated conversion. */
type RawFields = Record<string, string | undefined>;

type Section = 'top' | 'findings' | 'acceptance_criteria';

interface RawHeader {
  outcome?: string;
  findings: RawFields[];
  acceptanceCriteria: RawFields[];
}

/**
 * Walks the header lines once, tracking which block (`top` /
 * `findings:` / `acceptance_criteria:`) is currently open. Item lines start
 * with a dash (`- key: value`, any positive indent); subsequent indented
 * non-dash lines are further `key: value` fields on the open item. Blank
 * lines are ignored everywhere. An indented line encountered while no array
 * block is open is a structural error (fails loud, per ruling 3) — an
 * unrecognized *top-level* key is tolerated and ignored (forward-compatible
 * with header metadata this parser doesn't yet know about).
 */
function parseHeaderLines(lines: string[]): DispatchResult<RawHeader> {
  let section: Section = 'top';
  let outcome: string | undefined;
  const findings: RawFields[] = [];
  const acceptanceCriteria: RawFields[] = [];
  let currentItem: RawFields | null = null;

  const flushItem = (): void => {
    if (currentItem) {
      if (section === 'findings') findings.push(currentItem);
      else if (section === 'acceptance_criteria') acceptanceCriteria.push(currentItem);
    }
    currentItem = null;
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();

    if (indent === 0) {
      flushItem();
      const kv = parseKeyValue(trimmed);
      if (!kv) {
        return fail('REVIEW_PARSE_FAILED', `Malformed header line (expected 'key: value'): "${rawLine}"`);
      }
      if (kv.key === 'outcome') {
        outcome = kv.value;
        section = 'top';
      } else if (kv.key === 'findings') {
        section = 'findings';
      } else if (kv.key === 'acceptance_criteria') {
        section = 'acceptance_criteria';
      } else {
        section = 'top';
      }
      continue;
    }

    // Indented line: only valid inside an open findings/acceptance_criteria block.
    if (section === 'top') {
      return fail(
        'REVIEW_PARSE_FAILED',
        `Unexpected indented line outside of a findings/acceptance_criteria block: "${rawLine}"`,
      );
    }

    if (trimmed.startsWith('- ') || trimmed === '-') {
      flushItem();
      currentItem = {};
      const rest = trimmed.slice(1).trim();
      if (rest !== '') {
        const kv = parseKeyValue(rest);
        if (!kv) {
          return fail('REVIEW_PARSE_FAILED', `Malformed item line (expected '- key: value'): "${rawLine}"`);
        }
        currentItem[kv.key] = kv.value;
      }
      continue;
    }

    if (!currentItem) {
      return fail('REVIEW_PARSE_FAILED', `Field line found before any '- ' item start: "${rawLine}"`);
    }
    const kv = parseKeyValue(trimmed);
    if (!kv) {
      return fail('REVIEW_PARSE_FAILED', `Malformed field line (expected 'key: value'): "${rawLine}"`);
    }
    currentItem[kv.key] = kv.value;
  }
  flushItem();

  return ok({ outcome, findings, acceptanceCriteria });
}

function buildFinding(raw: RawFields, index: number): DispatchResult<ReviewFinding> {
  const id = raw.id?.trim();
  if (!id) {
    return fail('REVIEW_PARSE_FAILED', `Finding #${index + 1} is missing required field 'id'.`);
  }

  const severityRaw = raw.severity?.trim();
  if (!severityRaw || !isFindingSeverity(severityRaw)) {
    return fail(
      'REVIEW_PARSE_FAILED',
      `Finding "${id}" has missing or invalid 'severity' (got: ${severityRaw ?? '<absent>'}). Must be one of: ${FINDING_SEVERITIES.join(', ')}.`,
    );
  }

  const blockingRaw = raw.blocking;
  const blocking = blockingRaw === undefined ? undefined : parseBoolean(blockingRaw);
  if (blocking === undefined) {
    return fail(
      'REVIEW_PARSE_FAILED',
      `Finding "${id}" has missing or invalid 'blocking' (got: ${blockingRaw ?? '<absent>'}). Must be a boolean (true/false/yes/no).`,
    );
  }

  const summary = raw.summary?.trim();
  if (!summary) {
    return fail('REVIEW_PARSE_FAILED', `Finding "${id}" is missing required non-empty field 'summary'.`);
  }

  const finding: ReviewFinding = { id, severity: severityRaw, blocking, summary };
  if (raw.detail !== undefined) finding.detail = raw.detail;
  if (raw.ac !== undefined) finding.ac = raw.ac;
  return ok(finding);
}

function buildACResult(raw: RawFields, index: number): DispatchResult<ACResult> {
  const criterion = raw.criterion?.trim();
  if (!criterion) {
    return fail(
      'REVIEW_PARSE_FAILED',
      `Acceptance criterion #${index + 1} is missing required non-empty field 'criterion'.`,
    );
  }

  const passRaw = raw.pass;
  const pass = passRaw === undefined ? undefined : parseBoolean(passRaw);
  if (pass === undefined) {
    return fail(
      'REVIEW_PARSE_FAILED',
      `Acceptance criterion "${criterion}" has missing or invalid 'pass' (got: ${passRaw ?? '<absent>'}). Must be a boolean (true/false/yes/no).`,
    );
  }

  const result: ACResult = { criterion, pass };
  if (raw.notes !== undefined) result.notes = raw.notes;
  return ok(result);
}

/**
 * Parse the structured review header from a `code_review` worker's response
 * (s6-rulings.md ruling 3). Returns `ok` with the parsed, fully-validated
 * result, or `fail('REVIEW_PARSE_FAILED', ...)` describing exactly what was
 * wrong — malformed/missing delimiters, malformed YAML, missing required
 * fields, an invalid enum value, or a cross-field contradiction between
 * `outcome` and the findings' `blocking` flags. There is no partial-success
 * shape: either every rule below holds, or the run is `failed`.
 */
export function parseReviewHeader(responseText: string): DispatchResult<StructuredReviewResult> {
  const blockResult = extractHeaderBlock(responseText);
  if (!blockResult.ok) return blockResult;

  const parsed = parseHeaderLines(blockResult.data);
  if (!parsed.ok) return parsed;
  const { outcome: outcomeRaw, findings: rawFindings, acceptanceCriteria: rawAC } = parsed.data;

  if (!outcomeRaw || !isReviewOutcome(outcomeRaw)) {
    return fail(
      'REVIEW_PARSE_FAILED',
      `Missing or invalid 'outcome' (got: ${outcomeRaw ?? '<absent>'}). Must be one of: ${REVIEW_OUTCOMES.join(', ')}.`,
    );
  }

  const findings: ReviewFinding[] = [];
  for (let i = 0; i < rawFindings.length; i++) {
    const built = buildFinding(rawFindings[i]!, i);
    if (!built.ok) return built;
    findings.push(built.data);
  }

  const acceptanceCriteria: ACResult[] = [];
  for (let i = 0; i < rawAC.length; i++) {
    const built = buildACResult(rawAC[i]!, i);
    if (!built.ok) return built;
    acceptanceCriteria.push(built.data);
  }

  const hasBlockingFinding = findings.some((finding) => finding.blocking);
  if (outcomeRaw === 'changes-requested' && !hasBlockingFinding) {
    return fail(
      'REVIEW_PARSE_FAILED',
      "outcome is 'changes-requested' but no finding has blocking: true.",
    );
  }
  if (outcomeRaw === 'pass' && hasBlockingFinding) {
    return fail(
      'REVIEW_PARSE_FAILED',
      "outcome is 'pass' but at least one finding has blocking: true.",
    );
  }

  return ok({ outcome: outcomeRaw, findings, acceptanceCriteria });
}
