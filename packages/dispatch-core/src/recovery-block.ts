/**
 * `kb-dispatch-recovery.v1` schema: types, terminal-block extraction, and
 * validation (PLN-0004 Session C / S6a.1; binding spec —
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md` ruling 1,
 * "D1: Structured recovery signal"). Replaces the deleted `needs:` field
 * (DEC-0010) and the bespoke `.dispatch-out/review.yaml` file channel with
 * one schema across every role that emits it: `implement` (worker),
 * `code_review` (reviewer), and `redteam`. The worker/reviewer/redteam emits
 * exactly one fenced JSON block, info-string `kb-dispatch-recovery.v1`, as
 * the terminal content of its LLM output; this module extracts and
 * validates that block. `research` is prose-only (ruling 1 item 1) and never
 * emits this block — this module is never invoked for it.
 *
 * Design source: agent-chassis's `agent-role-result.v1`
 * (`agent-launch-core/data/agent-role-result.v1.schema.json`,
 * `agent-launch-core/src/lib/agent-role-result.mjs`). ELv2 — the DESIGN is
 * mirrored (terminal-position fenced-block scan; closed-vocabulary,
 * cross-field validation; a `child_evidence_only` evidence envelope that
 * never throws); every line of TypeScript below is freshly written, none of
 * it copied.
 *
 * Divergences from agent-chassis (all ruled — see ruling 1 for the full
 * rationale):
 *
 * 1. `schema_version` is kb's own `kb-dispatch-recovery.v1`, not
 *    `agent-role-result.v1`.
 * 2. `kind` (ruling 1 item 5) is a kb-specific extension absent from
 *    agent-role-result.v1: a closed 5-value enum, meaningful only for
 *    `reported_role: "worker"`, that the orchestrator reads for
 *    widen/retry/stop routing. It is optional diagnostic enrichment — a
 *    block that omits it is still valid.
 * 3. Worker `findings`/`finding_counts`/`reviewed_controls` are NOT required
 *    to be empty (ruling 1 item 7 — deliberate divergence). Rejecting an
 *    otherwise-valid block because a worker reported an incidental finding
 *    would also discard `kind`, the signal the block exists for. The three
 *    agent-chassis worker-emptiness checks (`worker_findings_not_empty`,
 *    `worker_finding_counts_not_zero`, `worker_reviewed_controls_not_empty`)
 *    are deliberately not implemented; see the comment at their would-be
 *    call site in `validateRecoveryPayload` for exactly how to re-enable
 *    them if a future ruling reverses this.
 * 4. Extraction is fence-only. agent-chassis also accepts a whole-response
 *    raw JSON object with no fence at all; kb's transport contract (ruling 1
 *    item 2) commits to "one fenced block" as the terminal content, and
 *    accepting an unfenced blob would reopen exactly the prose-parsing
 *    ambiguity ruling 1 closes (see "Old fenced-block problem resolved" in
 *    the ruling doc). Only fenced candidates are scanned.
 * 5. No duplicate-JSON-key detection and no summary-prose-vs-count
 *    cross-check (agent-chassis has both). Neither is in this slice's
 *    stated validation list; omitted per simplicity-first rather than
 *    silently dropped — flagged here for anyone diffing against
 *    agent-chassis.
 *
 * Fail-closed and non-throwing: every exported function always returns a
 * `RecoveryBlockEvidence` envelope, never throws, and always stamps
 * `authority: "child_evidence_only"` — this block is diagnostic evidence
 * only. Delivery authority is the scope-checked commit (ruling 1 item 6); a
 * missing or malformed block loses diagnostic evidence, never delivery. The
 * evidence envelope is deliberately not a `DispatchResult` (errors.ts) —
 * unlike a `DispatchResult`, it must carry a full diagnostics list and a
 * fixed authority stamp even on failure, and this module takes no
 * dependency on the rest of dispatch-core to stay trivially unit-testable
 * against raw strings/JSON.
 */

// ---------------------------------------------------------------------------
// Schema version + transport
// ---------------------------------------------------------------------------

export const KB_DISPATCH_RECOVERY_VERSION = 'kb-dispatch-recovery.v1' as const;

/** Fence info-string markers this module recognizes (case-insensitive, matched as a whole word — see `matchesFenceMarker`). */
export const RECOVERY_FENCE_MARKERS: readonly string[] = ['kb-dispatch-recovery.v1'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Worker-only recovery-kind vocabulary (ruling 1 item 5) — informs the
 * orchestrator's widen/retry/stop routing. Closed but versionable: future
 * slices may extend it via a schema bump, never by silently widening this
 * union.
 */
export type RecoveryKind =
  | 'scope_insufficient'
  | 'dependency_missing'
  | 'spec_unclear'
  | 'partial_progress'
  | 'resource_limit';

/** `implement` (worker) role outcomes. */
export type WorkerOutcome = 'completed' | 'partial' | 'blocked' | 'failed';

/** `code_review`/`redteam` role outcomes. */
export type FindingsOutcome = 'no_findings' | 'passed_no_blocking_or_medium_findings' | 'changes_requested';

/** Roles this schema covers. */
export type ReportedRole = 'worker' | 'reviewer' | 'redteam';

/** Finding severity (mirrors agent-chassis's closed vocabulary). */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AffectedPath {
  path: string;
  line: number | null;
}

export interface RecoveryFinding {
  id: string;
  title: string;
  severity: FindingSeverity;
  blocking: boolean;
  affected_paths: AffectedPath[];
  control_id: string | null;
}

export interface FindingCounts {
  total: number;
  blocking: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface ReviewedControl {
  control_id: string;
  result: 'pass' | 'fail';
}

/**
 * The full `kb-dispatch-recovery.v1` payload, after validation. Every field
 * is always present on a validated result (never `undefined`) — absence in
 * the raw JSON normalizes to `null` for the nullable fields (`summary`,
 * `kind`, `control_id`, `line`), so callers never need an
 * `in`/`hasOwnProperty` check.
 */
export interface RecoveryBlockPayload {
  schema_version: typeof KB_DISPATCH_RECOVERY_VERSION;
  reported_role: ReportedRole;
  reported_subject: string;
  reported_outcome: WorkerOutcome | FindingsOutcome;
  summary: string | null;
  findings: RecoveryFinding[];
  finding_counts: FindingCounts;
  reviewed_controls: ReviewedControl[];
  /** kb extension (divergence 2 above). Always `null` for reviewer/redteam. */
  kind: RecoveryKind | null;
}

export interface RecoveryDiagnostic {
  code: string;
  message: string;
  path?: string;
  detail?: Record<string, unknown>;
}

/**
 * Extraction/validation result envelope. `authority: "child_evidence_only"`
 * is stamped unconditionally (ruling 1 item 6) — this object is never
 * delivery authority, regardless of `valid`.
 */
export interface RecoveryBlockEvidence {
  valid: boolean;
  result: RecoveryBlockPayload | null;
  diagnostics: RecoveryDiagnostic[];
  authority: 'child_evidence_only';
}

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export const REPORTED_ROLES: readonly ReportedRole[] = ['worker', 'reviewer', 'redteam'];
export const WORKER_OUTCOMES: readonly WorkerOutcome[] = ['completed', 'partial', 'blocked', 'failed'];
export const FINDINGS_OUTCOMES: readonly FindingsOutcome[] = [
  'no_findings',
  'passed_no_blocking_or_medium_findings',
  'changes_requested',
];
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const RECOVERY_KINDS: readonly RecoveryKind[] = [
  'scope_insufficient',
  'dependency_missing',
  'spec_unclear',
  'partial_progress',
  'resource_limit',
];

const TOP_LEVEL_REQUIRED_FIELDS: readonly string[] = [
  'schema_version',
  'reported_role',
  'reported_subject',
  'reported_outcome',
  'findings',
  'finding_counts',
  'reviewed_controls',
];
/** `kind` (divergence 2) rides alongside `summary` as a top-level optional field. */
const TOP_LEVEL_OPTIONAL_FIELDS: readonly string[] = ['summary', 'kind'];
const FINDING_REQUIRED_FIELDS: readonly string[] = ['id', 'title', 'severity', 'blocking', 'affected_paths'];
const FINDING_OPTIONAL_FIELDS: readonly string[] = ['control_id'];
const AFFECTED_PATH_FIELDS: readonly string[] = ['path', 'line'];
const FINDING_COUNT_FIELDS: readonly (keyof FindingCounts)[] = [
  'total',
  'blocking',
  'critical',
  'high',
  'medium',
  'low',
  'info',
];
const REVIEWED_CONTROL_FIELDS: readonly string[] = ['control_id', 'result'];

/**
 * Fields forbidden in the child payload (ruling 1 item 6): backend/authority
 * facts the worker must never assert. Mirrors agent-chassis's
 * `AUTHORITY_FIELD_NAMES` vocabulary — "run_id, status, terminal_status,
 * source_digest, and equivalents".
 */
const AUTHORITY_FIELD_NAMES = new Set<string>([
  'run_id',
  'status',
  'terminal_status',
  'source_digest',
  'role_authority',
  'subject_authority',
  'source_digest_authority',
  'reviewed_at',
  'completed_at',
  'monitor_handle',
]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

type AddDiagnostic = (code: string, message: string, path?: string, detail?: Record<string, unknown>) => void;

function diag(code: string, message: string, path?: string, detail?: Record<string, unknown>): RecoveryDiagnostic {
  const diagnostic: RecoveryDiagnostic = { code, message };
  if (path !== undefined) diagnostic.path = path;
  if (detail !== undefined) diagnostic.detail = detail;
  return diagnostic;
}

function closedEvidence(diagnostics: RecoveryDiagnostic[]): RecoveryBlockEvidence {
  return { valid: false, result: null, diagnostics, authority: 'child_evidence_only' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isReportedRole(value: unknown): value is ReportedRole {
  return typeof value === 'string' && (REPORTED_ROLES as readonly string[]).includes(value);
}

function isWorkerOutcome(value: unknown): value is WorkerOutcome {
  return typeof value === 'string' && (WORKER_OUTCOMES as readonly string[]).includes(value);
}

function isFindingsOutcome(value: unknown): value is FindingsOutcome {
  return typeof value === 'string' && (FINDINGS_OUTCOMES as readonly string[]).includes(value);
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

function isRecoveryKind(value: unknown): value is RecoveryKind {
  return typeof value === 'string' && (RECOVERY_KINDS as readonly string[]).includes(value);
}

/**
 * Repo-relative path guard for `affected_paths[].path` (mirrors
 * agent-chassis's same check): no absolute paths, no Windows drive letters,
 * no null bytes, no `~`, no `.`/`..` segments.
 */
function isRepoRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes('\0') || value.startsWith('~')) return false;
  return value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

// ---------------------------------------------------------------------------
// Extraction: terminal fenced-block scan (ruling 1 item 3)
// ---------------------------------------------------------------------------

interface FenceBlock {
  start: number;
  end: number;
  info: string;
  body: string;
}

/**
 * Collects every well-formed fenced code block in `text` (opening
 * ` ``` `+info-string on its own line, closing ` ``` ` alone on its own
 * line or at end-of-string). `end` points immediately after the closing
 * backticks, deliberately NOT including any trailing spaces/tabs on that
 * line — those are trailing whitespace like any other, so `end` lines up
 * exactly with `text.search(/\s*$/)` (the terminal-position check below)
 * even when the model pads the closing fence line with spaces. Caller
 * normalizes CRLF -> LF first, so only `\n` needs handling here.
 */
function collectFences(text: string): FenceBlock[] {
  const fences: FenceBlock[] = [];
  const pattern = /(^|\n)```([^\n`]*)\n([\s\S]*?)\n```(?=[ \t]*(?:\n|$))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const leadingNewline = match[1] === '\n' ? 1 : 0;
    fences.push({
      start: match.index + leadingNewline,
      end: match.index + match[0].length,
      info: match[2].trim(),
      body: match[3],
    });
  }
  return fences;
}

/** Case-insensitive whole-word match against `RECOVERY_FENCE_MARKERS`. */
function matchesFenceMarker(info: string): boolean {
  const words = info.toLowerCase().trim().split(/\s+/).filter((word) => word.length > 0);
  return RECOVERY_FENCE_MARKERS.some((marker) => words.includes(marker));
}

function isJsonObjectText(text: string): boolean {
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    return isPlainObject(JSON.parse(text));
  } catch {
    return false;
  }
}

type TerminalCandidate = { ok: true; jsonText: string } | { ok: false; diagnostics: RecoveryDiagnostic[] };

/**
 * Terminal-position scan (ruling 1 item 3): finds the fenced block whose
 * info-string carries the `kb-dispatch-recovery.v1` marker, requires it to
 * be the sole JSON-shaped candidate in the output, and requires it to be the
 * terminal content (trailing whitespace OK, trailing prose not OK). No
 * unfenced/raw-JSON fallback (divergence 4 above) — the transport contract
 * is fence-only.
 */
function extractTerminalCandidate(text: string): TerminalCandidate {
  const trimEnd = text.search(/\s*$/);
  const fences = collectFences(text);

  const marked: FenceBlock[] = [];
  const unmarkedJson: FenceBlock[] = [];
  for (const fence of fences) {
    if (matchesFenceMarker(fence.info)) {
      marked.push(fence);
    } else if (isJsonObjectText(fence.body.trim())) {
      unmarkedJson.push(fence);
    }
  }

  const totalCandidates = marked.length + unmarkedJson.length;
  if (totalCandidates === 0) {
    return {
      ok: false,
      diagnostics: [
        diag('missing_result', `final output does not contain a terminal ${KB_DISPATCH_RECOVERY_VERSION} fenced block`),
      ],
    };
  }
  if (totalCandidates > 1) {
    return {
      ok: false,
      diagnostics: [
        diag('multiple_json_candidates', 'final output contains more than one JSON candidate block', undefined, {
          candidate_count: totalCandidates,
        }),
      ],
    };
  }
  if (marked.length === 0) {
    return {
      ok: false,
      diagnostics: [
        diag(
          'ordinary_json_code_block',
          `JSON code block is missing the ${KB_DISPATCH_RECOVERY_VERSION} info-string marker`,
        ),
      ],
    };
  }

  const fence = marked[0];
  if (fence.end !== trimEnd) {
    return {
      ok: false,
      diagnostics: [
        diag(
          'trailing_prose_after_result',
          `the ${KB_DISPATCH_RECOVERY_VERSION} block must be the terminal content of the output`,
        ),
      ],
    };
  }

  return { ok: true, jsonText: fence.body.trim() };
}

/**
 * Extract and validate the terminal `kb-dispatch-recovery.v1` block from a
 * worker/reviewer/redteam's raw LLM output. Fail-closed: a missing or
 * malformed block returns `valid: false` with diagnostics — it never
 * throws, and (per ruling 1 item 6) a closed envelope never by itself
 * invalidates an authenticated delivery; the caller decides what that means
 * for its own control flow.
 */
export function extractRecoveryBlock(workerOutput: string): RecoveryBlockEvidence {
  if (typeof workerOutput !== 'string') {
    return closedEvidence([diag('invalid_response_text', 'worker output must be a string')]);
  }

  const normalized = workerOutput.replace(/\r\n/g, '\n');
  const candidate = extractTerminalCandidate(normalized);
  if (!candidate.ok) {
    return closedEvidence(candidate.diagnostics);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.jsonText);
  } catch {
    return closedEvidence([diag('malformed_json', `${KB_DISPATCH_RECOVERY_VERSION} block is not valid JSON`)]);
  }

  return validateRecoveryPayload(parsed);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks `required` are present and every key is either required or
 * `optional`; unrecognized top-level keys that appear in
 * `AUTHORITY_FIELD_NAMES` get their own diagnostic (ruling 1 item 6).
 * Assumes the caller already confirmed `value` is a plain object.
 */
function validateExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  add: AddDiagnostic,
  opts: { forbidAuthorityFields?: boolean } = {},
): void {
  for (const key of required) {
    if (!hasOwn(value, key)) {
      add('missing_required_field', `${key} is required`, `${path}.${key}`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (opts.forbidAuthorityFields && AUTHORITY_FIELD_NAMES.has(key)) {
      add('authority_field_forbidden', 'child payload must not carry backend authority fields', `${path}.${key}`, {
        key,
      });
    } else {
      add('unknown_field', 'object contains a field outside the exact schema', `${path}.${key}`, { key });
    }
  }
}

function validateAffectedPaths(value: unknown, path: string, add: AddDiagnostic): void {
  if (!Array.isArray(value)) {
    add('invalid_affected_paths', 'affected_paths must be an array', path);
    return;
  }
  const items = value as unknown[];
  items.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(raw)) {
      add('invalid_affected_path', 'affected path must be a JSON object', itemPath);
      return;
    }
    validateExactKeys(raw, AFFECTED_PATH_FIELDS, [], itemPath, add);

    const pathValue = raw.path;
    if (typeof pathValue !== 'string' || !isRepoRelativePath(pathValue)) {
      add('invalid_affected_path', 'affected path must be a repo-relative path', `${itemPath}.path`);
    }

    const line = raw.line;
    const lineValid = line === null || (typeof line === 'number' && Number.isInteger(line) && line >= 1);
    if (!lineValid) {
      add('invalid_affected_line', 'affected path line must be a positive integer or null', `${itemPath}.line`);
    }
  });
}

function validateFindings(value: unknown, add: AddDiagnostic): RecoveryFinding[] | null {
  if (!Array.isArray(value)) {
    add('invalid_findings', 'findings must be an array', '$.findings');
    return null;
  }
  const items = value as unknown[];
  const ids = new Set<string>();
  const normalized: RecoveryFinding[] = [];

  items.forEach((raw, index) => {
    const path = `$.findings[${index}]`;
    if (!isPlainObject(raw)) {
      add('invalid_finding', 'finding must be a JSON object', path);
      return;
    }
    validateExactKeys(raw, FINDING_REQUIRED_FIELDS, FINDING_OPTIONAL_FIELDS, path, add);

    const id = raw.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      add('invalid_finding_id', 'finding id must be a non-empty string', `${path}.id`);
    } else if (ids.has(id)) {
      add('duplicate_finding_id', 'finding id must be unique within findings', `${path}.id`);
    } else {
      ids.add(id);
    }

    const title = raw.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      add('invalid_finding_title', 'finding title must be a non-empty string', `${path}.title`);
    }

    if (!isFindingSeverity(raw.severity)) {
      add('invalid_severity', 'finding severity is outside the closed enum', `${path}.severity`);
    }

    if (typeof raw.blocking !== 'boolean') {
      add('invalid_blocking', 'finding blocking must be a boolean', `${path}.blocking`);
    }

    validateAffectedPaths(raw.affected_paths, `${path}.affected_paths`, add);

    const controlId = raw.control_id;
    if (hasOwn(raw, 'control_id') && controlId !== null) {
      if (typeof controlId !== 'string' || controlId.trim().length === 0) {
        add('invalid_control_id', 'control_id must be a non-empty string or null', `${path}.control_id`);
      }
    }

    normalized.push(raw as unknown as RecoveryFinding);
  });

  return normalized;
}

function recomputeFindingCounts(findings: RecoveryFinding[]): FindingCounts {
  const counts: FindingCounts = { total: findings.length, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    if (finding.blocking === true) counts.blocking += 1;
    if (isFindingSeverity(finding.severity)) counts[finding.severity] += 1;
  }
  return counts;
}

function validateFindingCounts(value: unknown, add: AddDiagnostic): FindingCounts | null {
  if (!isPlainObject(value)) {
    add('invalid_finding_counts', 'finding_counts must be a JSON object', '$.finding_counts');
    return null;
  }
  validateExactKeys(value, FINDING_COUNT_FIELDS, [], '$.finding_counts', add);
  for (const field of FINDING_COUNT_FIELDS) {
    const fieldValue = value[field];
    const fieldValid = typeof fieldValue === 'number' && Number.isInteger(fieldValue) && fieldValue >= 0;
    if (!fieldValid) {
      add('invalid_finding_count', 'finding_counts fields must be non-negative integers', `$.finding_counts.${field}`);
    }
  }
  return value as unknown as FindingCounts;
}

function validateFindingCountConsistency(findings: RecoveryFinding[], counts: FindingCounts, add: AddDiagnostic): void {
  const recomputed = recomputeFindingCounts(findings);
  for (const field of FINDING_COUNT_FIELDS) {
    if (counts[field] !== recomputed[field]) {
      add('finding_count_mismatch', 'finding_counts does not match recomputed findings', `$.finding_counts.${field}`, {
        expected: recomputed[field],
        actual: counts[field],
      });
    }
  }
  if (counts.blocking > counts.total) {
    add('finding_count_mismatch', 'finding_counts.blocking cannot exceed total', '$.finding_counts.blocking');
  }
}

function validateReviewedControls(value: unknown, add: AddDiagnostic): void {
  if (!Array.isArray(value)) {
    add('invalid_reviewed_controls', 'reviewed_controls must be an array', '$.reviewed_controls');
    return;
  }
  const items = value as unknown[];
  const seen = new Set<string>();
  items.forEach((raw, index) => {
    const path = `$.reviewed_controls[${index}]`;
    if (!isPlainObject(raw)) {
      add('invalid_reviewed_control', 'reviewed control must be a JSON object', path);
      return;
    }
    validateExactKeys(raw, REVIEWED_CONTROL_FIELDS, [], path, add);

    const controlId = raw.control_id;
    if (typeof controlId !== 'string' || controlId.trim().length === 0) {
      add('invalid_reviewed_control_id', 'control_id must be a non-empty string', `${path}.control_id`);
    } else if (seen.has(controlId)) {
      add('duplicate_reviewed_control', 'reviewed_controls must not duplicate control_id values', `${path}.control_id`);
    } else {
      seen.add(controlId);
    }

    const result = raw.result;
    if (result !== 'pass' && result !== 'fail') {
      add('invalid_reviewed_control_result', 'reviewed control result must be pass or fail', `${path}.result`);
    }
  });
}

function validateOutcomeConsistency(
  outcome: FindingsOutcome,
  findings: RecoveryFinding[],
  counts: FindingCounts,
  add: AddDiagnostic,
): void {
  if (outcome === 'no_findings' && counts.total !== 0) {
    add('outcome_findings_mismatch', 'no_findings requires zero findings', '$.reported_outcome');
  }
  if (
    outcome === 'passed_no_blocking_or_medium_findings' &&
    (counts.blocking !== 0 || counts.critical !== 0 || counts.high !== 0 || counts.medium !== 0)
  ) {
    add(
      'outcome_findings_mismatch',
      'passed_no_blocking_or_medium_findings allows only low/info non-blocking findings',
      '$.reported_outcome',
    );
  }
  if (outcome === 'changes_requested' && findings.length === 0) {
    add('outcome_findings_mismatch', 'changes_requested requires at least one finding', '$.reported_outcome');
  }
}

/**
 * Validates the kb-specific `kind` extension (divergence 2): optional for
 * every role, but when present it must be one of the 5 closed values, and
 * only a worker payload may set it to a non-null value.
 */
function validateRecoveryKind(payload: Record<string, unknown>, isWorker: boolean, add: AddDiagnostic): void {
  if (!hasOwn(payload, 'kind') || payload.kind === null || payload.kind === undefined) return;
  if (!isWorker) {
    add(
      'kind_not_allowed_for_role',
      'kind is a worker-only field; reviewer/redteam payloads must omit it or set it to null',
      '$.kind',
    );
    return;
  }
  if (!isRecoveryKind(payload.kind)) {
    add('invalid_kind', 'kind is not in the allowed recovery-kind vocabulary', '$.kind', { allowed: RECOVERY_KINDS });
  }
}

function normalizeFinding(raw: Record<string, unknown>): RecoveryFinding {
  const rawPaths = raw.affected_paths as unknown[];
  const affectedPaths: AffectedPath[] = rawPaths.map((item) => {
    const ap = item as Record<string, unknown>;
    const line = ap.line;
    return { path: ap.path as string, line: typeof line === 'number' ? line : null };
  });
  const controlId = raw.control_id;
  return {
    id: raw.id as string,
    title: raw.title as string,
    severity: raw.severity as FindingSeverity,
    blocking: raw.blocking as boolean,
    affected_paths: affectedPaths,
    control_id: typeof controlId === 'string' ? controlId : null,
  };
}

function buildPayload(payload: Record<string, unknown>): RecoveryBlockPayload {
  const isWorker = payload.reported_role === 'worker';
  const kind = isWorker && isRecoveryKind(payload.kind) ? payload.kind : null;
  const summary = typeof payload.summary === 'string' ? payload.summary : null;

  return {
    schema_version: KB_DISPATCH_RECOVERY_VERSION,
    reported_role: payload.reported_role as ReportedRole,
    reported_subject: payload.reported_subject as string,
    reported_outcome: payload.reported_outcome as WorkerOutcome | FindingsOutcome,
    summary,
    findings: (payload.findings as Record<string, unknown>[]).map(normalizeFinding),
    finding_counts: { ...(payload.finding_counts as FindingCounts) },
    reviewed_controls: (payload.reviewed_controls as Record<string, unknown>[]).map((raw) => ({
      control_id: raw.control_id as string,
      result: raw.result as 'pass' | 'fail',
    })),
    kind,
  };
}

/**
 * Validates an already-parsed `kb-dispatch-recovery.v1` payload. Diagnostics
 * accumulate across every check (never short-circuits after the first
 * failure) so a malformed block reports everything wrong with it in one
 * pass. Returns `valid: true` with a fully-normalized `result` only when no
 * diagnostic fired.
 */
export function validateRecoveryPayload(payload: unknown): RecoveryBlockEvidence {
  if (!isPlainObject(payload)) {
    return closedEvidence([
      diag('invalid_payload_type', `${KB_DISPATCH_RECOVERY_VERSION} payload must be a JSON object`),
    ]);
  }

  const diagnostics: RecoveryDiagnostic[] = [];
  const add: AddDiagnostic = (code, message, path, detail) => {
    diagnostics.push(diag(code, message, path, detail));
  };

  validateExactKeys(payload, TOP_LEVEL_REQUIRED_FIELDS, TOP_LEVEL_OPTIONAL_FIELDS, '$', add, {
    forbidAuthorityFields: true,
  });

  if (payload.schema_version !== KB_DISPATCH_RECOVERY_VERSION) {
    add('schema_mismatch', `schema_version must equal ${KB_DISPATCH_RECOVERY_VERSION}`, '$.schema_version');
  }

  if (!isReportedRole(payload.reported_role)) {
    add('invalid_reported_role', 'reported_role is not in the allowed role vocabulary', '$.reported_role');
  }
  if (typeof payload.reported_subject !== 'string' || payload.reported_subject.trim().length === 0) {
    add('invalid_reported_subject', 'reported_subject must be a non-empty string', '$.reported_subject');
  }

  const isWorker = payload.reported_role === 'worker';
  const isFindingsRole = payload.reported_role === 'reviewer' || payload.reported_role === 'redteam';

  if (isWorker) {
    if (!isWorkerOutcome(payload.reported_outcome)) {
      add('role_outcome_mismatch', 'worker payload must use a worker outcome', '$.reported_outcome');
    }
  } else if (isFindingsRole) {
    if (!isFindingsOutcome(payload.reported_outcome)) {
      add('role_outcome_mismatch', 'reviewer/redteam payload must use a findings outcome', '$.reported_outcome');
    }
  } else {
    add('invalid_reported_outcome', 'reported_outcome cannot be validated for an unknown role', '$.reported_outcome');
  }

  if (hasOwn(payload, 'summary') && payload.summary !== null && typeof payload.summary !== 'string') {
    add('invalid_summary', 'summary must be a string or null when present', '$.summary');
  }

  const findings = validateFindings(payload.findings, add);
  const counts = validateFindingCounts(payload.finding_counts, add);
  validateReviewedControls(payload.reviewed_controls, add);

  // Divergence from agent-chassis (ruling 1 item 7): worker
  // findings/finding_counts/reviewed_controls are deliberately NOT required
  // to be empty. To match agent-chassis exactly, re-add three conditionals
  // here, each gated on `isWorker`:
  //   findings.length > 0           -> 'worker_findings_not_empty'
  //   any finding_counts field != 0 -> 'worker_finding_counts_not_zero'
  //   reviewed_controls.length > 0  -> 'worker_reviewed_controls_not_empty'

  if (findings && counts) {
    validateFindingCountConsistency(findings, counts, add);
    if (isFindingsRole && isFindingsOutcome(payload.reported_outcome)) {
      validateOutcomeConsistency(payload.reported_outcome, findings, counts, add);
    }
  }

  validateRecoveryKind(payload, isWorker, add);

  if (diagnostics.length > 0) {
    return closedEvidence(diagnostics);
  }

  return {
    valid: true,
    result: buildPayload(payload),
    diagnostics: [],
    authority: 'child_evidence_only',
  };
}
