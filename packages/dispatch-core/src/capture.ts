/**
 * §5/§8 capture (dispatch v2, PLN-0004 S0, T7-lite). Writes the
 * `HO-XXXX.response.md` doc into the run dir and computes the HO frontmatter
 * provenance fields for write-back.
 *
 * The response doc's canonical home is `wiki/handoffs/HO-XXXX.response.md`
 * in the mother repo (spec §5), paired with its HO contract. This module
 * only writes into the run dir (a plain, dispatch-owned staging directory —
 * spec §8's proven run-dir layout); placing the file into the mother repo's
 * `wiki/handoffs/` and merging `buildProvenanceWriteBack`'s fields into
 * `HO-XXXX.md` itself both touch the mother repo and are wave 3's
 * (`pipeline.ts`) job — this module computes content/fields only, no mother
 * repo I/O.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import type { DeliveryOutcome } from './delivery.js';
import type { BackendFingerprint } from './model-registry.js';
import type { RecoveryBlockEvidence, RecoveryBlockPayload } from './recovery-block.js';
import type { PiCompaction } from './adapters/pi.js';
import type { BackendFamily } from './repo-config.js';

/**
 * kb-owned location of the vendored LiteLLM rate snapshot (WK-0123) — mirrors
 * pipeline.ts's `KB_ROOT` resolution (this file lives at the same
 * `packages/dispatch-core/src/` depth). Always the RUNNING kb checkout's own
 * `contract/` dir, never `opts.dir` (the mother repo being dispatched into).
 */
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const KB_ROOT = resolve(THIS_DIR, '..', '..', '..');
const TOKEN_RATES_PATH = join(KB_ROOT, 'contract', 'token-rates.json');

/** One `contract/token-rates.json` row. `null` = no known rate for that bucket. */
export interface TokenRateEntry {
  input_per_1m: number | null;
  output_per_1m: number | null;
  cache_read_per_1m: number | null;
  cache_write_per_1m: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

let cachedTokenRates: Record<string, TokenRateEntry> | null = null;

/**
 * Load + parse the vendored `contract/token-rates.json` (WK-0123). Keys
 * starting with `_` are metadata (`_source`/`_captured`/`_notes`), not model
 * rows, and are skipped. Cached after the first read. Missing/malformed file
 * degrades to `{}` — every model then estimates to `null` (unavailable),
 * never a fabricated rate.
 */
export function loadTokenRates(): Record<string, TokenRateEntry> {
  if (cachedTokenRates) return cachedTokenRates;
  const table: Record<string, TokenRateEntry> = {};
  try {
    const raw = readFileSync(TOKEN_RATES_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('_') || !isRecord(value)) continue;
        table[key] = {
          input_per_1m: numberOrNull(value.input_per_1m),
          output_per_1m: numberOrNull(value.output_per_1m),
          cache_read_per_1m: numberOrNull(value.cache_read_per_1m),
          cache_write_per_1m: numberOrNull(value.cache_write_per_1m),
        };
      }
    }
  } catch {
    // Missing/malformed vendored table — degrade to empty (every model
    // estimates to unavailable rather than throwing).
  }
  cachedTokenRates = table;
  return cachedTokenRates;
}

/**
 * Per-field token usage (WK-0123) — widened from the old rolled-up
 * `{totalTokens, costUsd}` pair. Each adapter family reports a different
 * subset of fields; a field the family doesn't report is `null`, never a
 * fabricated 0 (0 means "reported zero", not "unknown").
 */
export interface WorkerUsageDetail {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Family-reported (Pi) or summed input+output (Codex/Claude). */
  totalTokens: number;
  /** Provider-reported cost; 0 when the provider doesn't report one (Codex) or the backend is a subscription seat. */
  costUsd: number;
}

/**
 * Compute `est_cost_usd` from the vendored rate table (WK-0123). Provider-
 * reported cost is authoritative when present and the backend isn't a
 * subscription seat; otherwise the estimate is rate-table-derived. Pi's
 * `WorkerUsageDetail` carries only `totalTokens` (no input/output split — see
 * the operator ruling in `wiki/issues/WK-0123.md`), so that case degrades to a
 * bounded `floor–ceiling` range rather than inventing a single blended number.
 */
/**
 * Older/looser callers (pre-WK-0123 test fixtures constructing `piResult`
 * by hand) may pass a `usage` object with only `{totalTokens, costUsd}` —
 * the new per-field keys come through as `undefined`, not `null`, in that
 * case. Normalize both to `null` ("unknown") so the rest of this module only
 * ever has to check one falsy-ish sentinel.
 */
function normalizeUsage(usage: WorkerUsageDetail): WorkerUsageDetail {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    totalTokens: usage.totalTokens ?? 0,
    costUsd: usage.costUsd ?? 0,
  };
}

export function computeEstCostUsd(
  rawUsage: WorkerUsageDetail,
  modelId: string | undefined,
  billing: 'seat' | 'api' | undefined,
): string {
  const usage = normalizeUsage(rawUsage);
  const useRateTable = billing === 'seat' || usage.costUsd === 0;
  if (!useRateTable) {
    return `$${usage.costUsd.toFixed(4)}`;
  }

  const rate = modelId ? loadTokenRates()[modelId] : undefined;
  if (!rate) return 'unavailable';

  const hasSplit = usage.inputTokens !== null && usage.outputTokens !== null;
  if (!hasSplit) {
    // Pi total-only ruling: bounded range, never a blended figure.
    if (usage.totalTokens <= 0 || rate.input_per_1m === null || rate.output_per_1m === null) return 'unavailable';
    const floor = (usage.totalTokens / 1_000_000) * rate.input_per_1m;
    const ceiling = (usage.totalTokens / 1_000_000) * rate.output_per_1m;
    return `$${floor.toFixed(4)}–$${ceiling.toFixed(4)}`;
  }

  let total = 0;
  let anyRate = false;
  if (usage.inputTokens !== null && rate.input_per_1m !== null) {
    total += (usage.inputTokens / 1_000_000) * rate.input_per_1m;
    anyRate = true;
  }
  if (usage.outputTokens !== null && rate.output_per_1m !== null) {
    total += (usage.outputTokens / 1_000_000) * rate.output_per_1m;
    anyRate = true;
  }
  if (usage.cacheReadTokens !== null && rate.cache_read_per_1m !== null) {
    total += (usage.cacheReadTokens / 1_000_000) * rate.cache_read_per_1m;
    anyRate = true;
  }
  if (usage.cacheWriteTokens !== null && rate.cache_write_per_1m !== null) {
    total += (usage.cacheWriteTokens / 1_000_000) * rate.cache_write_per_1m;
    anyRate = true;
  }
  if (!anyRate) return 'unavailable';
  return `$${total.toFixed(4)}`;
}

function formatTokenCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

/**
 * Render the `## Token Detail` section (WK-0123): the full per-field
 * breakdown a family reports (nulls render as `—`), plus both the
 * provider-reported `cost_usd` and the rate-table-derived `est_cost_usd`.
 * Frontmatter keeps the old rolled-up `total_tokens`/`cost_usd` pair for
 * backward compat; this section is the new, non-lossy detail.
 */
function formatTokenDetailSection(
  rawUsage: WorkerUsageDetail | undefined,
  modelId: string | undefined,
  billing: 'seat' | 'api' | undefined,
): string[] {
  if (!rawUsage) return [];
  const usage = normalizeUsage(rawUsage);
  const estCostUsd = computeEstCostUsd(usage, modelId, billing);
  const rows: Array<[string, string]> = [
    ['input_tokens', formatTokenCount(usage.inputTokens)],
    ['output_tokens', formatTokenCount(usage.outputTokens)],
    ['cache_read_tokens', formatTokenCount(usage.cacheReadTokens)],
    ['cache_write_tokens', formatTokenCount(usage.cacheWriteTokens)],
    ['reasoning_tokens', formatTokenCount(usage.reasoningTokens)],
    ['total_tokens', formatTokenCount(usage.totalTokens)],
    ['cost_usd', `$${(billing === 'seat' ? 0 : usage.costUsd).toFixed(4)}`],
    ['est_cost_usd', estCostUsd],
  ];
  return [
    '## Token Detail',
    '',
    '| Field | Count |',
    '|-------|-------|',
    ...rows.map(([field, count]) => `| ${field} | ${count} |`),
    '',
  ];
}

export interface CaptureOpts {
  /** Windows path to the run dir */
  runDir: string;
  /** The handoff record */
  handoff: { id: string; title: string; mode: string };
  /** Delivery outcome */
  delivery: DeliveryOutcome;
  /** Worker adapter result (usage, outcome) — `usage` carries the full per-field breakdown (WK-0123). */
  piResult?: { outcome: string; usage: WorkerUsageDetail };
  /**
   * Bare model id (`ResolvedModel.modelId`, not the `backend/modelId`
   * canonical string in `model` below) — the rate-table lookup key
   * (`contract/token-rates.json` is keyed by canonical model id; WK-0123).
   */
  modelId?: string;
  /** Backend billing kind (`repo-config.ts`'s `BackendEntry.billing`; WK-0123) — defaults to `api` when absent. */
  billing?: 'seat' | 'api';
  /** Compaction statistics from parsePiOutput (T33 Phase 3). */
  compaction?: PiCompaction;
  /** Model used */
  model?: string;
  /**
   * Resolved backend family (pi/codex/claude), threaded from `model.family`
   * at the pipeline.ts call site (WK-0136). Used for the provenance
   * write-back's `agent` field, which previously hardcoded `'pi'`
   * regardless of which family actually ran; falls back to `model` when
   * absent.
   */
  family?: BackendFamily;
  /** Isolation backend */
  isolationBackend?: string;
  /**
   * The worker's final assistant message, verbatim (DEC-0010 diagnosis
   * channel) — rendered as the `## Worker Report` section, evidence only,
   * never consulted by the verdict ladder below. Typically `piResult`'s own
   * `lastAssistantText` (adapters/pi.ts).
   */
  lastAssistantText?: string;
  /** Credential profile names granted for this run (names only; S3 T10). */
  credentialsGranted?: string[];
  /** Resolved backend base_url actually used (never the {{WIN_HOST}} template; S3 ruling 8). */
  baseUrl?: string;
  /** Resolved backend name (S3 ruling 1/8). */
  backend?: string;
  /** Pi harness version captured by preflight's PI_VERSION probe (S3 ruling 7). */
  piVersion?: string;
  /**
   * Effort/reasoning level requested for this run (WK-0122) — deterministic
   * pipeline input (`DispatchOpts.effort`), never LLM output. Rendered as
   * `effort_requested` in the response doc frontmatter; empty string when
   * effort was not requested.
   */
  effort?: string;
  /** Best-effort backend fingerprint — host/model always present when probed, serverVersion null when the backend has no version endpoint (S3 ruling 8). */
  backendFingerprint?: BackendFingerprint;
  /**
   * Extracted + validated `kb-dispatch-recovery.v1` evidence (D1 ruling 1;
   * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md`) from the
   * worker/reviewer/redteam's terminal fenced output block. Rendered as a
   * `## Recovery Signal` section whenever present — an invalid/unparseable
   * block renders as a `**Parse failed:**` notice rather than being omitted
   * silently. DEC-0037 role asymmetry (reverses DEC-0023 V4 note 3 for
   * advisory modes; WK-0125), enforced in `deriveVerdict` below: for
   * `implement` this is diagnostic evidence only and never changes the
   * verdict (delivery authority is the scope-checked commit — WK-0125 adds
   * constrained decoding at the pipeline layer to make the block more
   * reliably parseable, without changing this asymmetry). For
   * `code_review`/`redteam` the block is now opportunistic: a valid block
   * drives mechanical merge gating (`delivered`, `delivery_method:
   * structured`); an absent/invalid block falls back to prose (`delivered`,
   * `delivery_method: prose_fallback`) instead of hard-failing the run.
   */
  recoveryEvidence?: RecoveryBlockEvidence;
  /**
   * The wiki source's commit at run time (WK-0135): the mother repo's own
   * HEAD when wiki/ is tracked (the clone commit IS the wiki commit), or the
   * separate nested-private wiki repo's HEAD otherwise. Best-effort —
   * undefined when the probe failed (pipeline.ts degrades gracefully rather
   * than failing the run). Rendered as `wiki_commit` in both the response
   * doc frontmatter and the HO provenance write-back.
   */
  wikiCommit?: string;
  inferenceProvider?: string;
  /**
   * Host-side, deterministic mount-write manifest (WK-0164): per-`export_mount`
   * files whose mtime is newer than the run's start time, walked by
   * pipeline.ts after the worker exits — never a worker self-report. Renders
   * as a `## Mount Writes` section when non-empty; omitted entirely when
   * absent/empty.
   */
  mountWrites?: Array<{ mountPath: string; files: string[] }>;
}

export interface CaptureResult {
  responsePath: string;
  responseContent: string;
}

export interface ProvenanceWriteBack {
  /** Fields to merge into the HO frontmatter */
  fields: Record<string, string | boolean | string[]>;
}

/**
 * DEC-0010 mechanical verdict vocabulary. Computed exclusively from
 * delivery-gate facts and mode deliverable checks (`deriveVerdict` below) —
 * no worker input is ever consulted. `timed_out`/`cancelled` are set at the
 * pipeline/controller level on paths that never reach `writeResponseDoc` at
 * all (e.g. a watchdog-killed worker); `deriveVerdict` itself never returns
 * them.
 */
type ResponseOutcome = 'delivered' | 'failed' | 'refused' | 'timed_out' | 'cancelled';

/**
 * Branch naming is a fixed convention (`dispatch/<handoffId>`), meaningful
 * only once a commit actually landed; refused/no-op/conflict/error outcomes
 * carry no branch value.
 */
function deriveBranch(handoffId: string, delivery: DeliveryOutcome): string {
  if (delivery.status === 'delivered') {
    return delivery.branch || `dispatch/${handoffId}`;
  }
  return '';
}

/**
 * `deriveVerdict`'s return: the mechanical outcome plus a machine-set reason
 * code for every non-`delivered` result. `deliveryMethod` (WK-0125/DEC-0037)
 * is a SEPARATE observability field from `reason` — it names how a
 * `code_review`/`redteam` result was obtained (`structured` from a valid
 * recovery block vs. `prose_fallback` from the chat transcript), not to be
 * confused with `DeliveryOutcome`/the git delivery-gate result the rest of
 * this module calls `delivery`. Unset for `implement`/`research`, where the
 * structured/prose fork doesn't apply.
 */
interface VerdictResult {
  outcome: ResponseOutcome;
  reason?: string;
  deliveryMethod?: 'structured' | 'prose_fallback';
}

/**
 * Mechanical verdict ladder (DEC-0010 rule 2 — "completion is mechanical;
 * workers never assert done/not-done"). Every branch reads only delivery-gate
 * facts, the handoff's mode, and (for research/redteam crash detection only)
 * the Pi adapter's facts-only process classification — never the worker's
 * chat text, and never a worker-authored self-report file as authority. The
 * one exception is `recoveryEvidence.valid` for code_review/redteam (DEC-0037,
 * below) — even there the branch reads only whether extraction/validation
 * succeeded, never the worker's narrative content inside the block.
 *
 * DEC-0037 role asymmetry (reverses DEC-0023 V4 note 3 —
 * `wiki/plans/PLN-0004/execution/mid_project_review_rulings.md` — for
 * advisory modes only; WK-0125): for `implement`, the `kb-dispatch-
 * recovery.v1` block is diagnostic evidence ONLY — an absent or malformed
 * block never changes this ladder's verdict, because delivery authority is
 * the scope-checked commit (unchanged by DEC-0037 — implement mode gets
 * constrained decoding at the pipeline layer instead, which makes the block
 * more reliably parseable without touching this ladder). For
 * `code_review`/`redteam`, the block is now opportunistic, not the
 * deliverable: a valid block drives mechanical merge gating (`delivered`,
 * `delivery_method: structured`); an absent or invalid block falls back to
 * prose (`delivered`, `delivery_method: prose_fallback`) instead of the old
 * hard `failed`/`missing_review_artifact` — the review's prose is the
 * deliverable when the structured shortcut isn't available, never a
 * discarded artifact.
 *
 * Ladder:
 *   1. Delivery-gate refusals (out-of-scope / secret-in-diff) -> `refused`.
 *   2. Delivery-gate errors (conflict / git error) -> `failed`.
 *   3. Mode-specific deliverable check:
 *      - implement: an in-scope diff landed on the branch -> `delivered`;
 *        an idempotent redelivery (`no_changes` — the exact same tree is
 *        already on the branch from the same base) -> also `delivered`;
 *        an empty delta (`no_delta` — the worker's tree matches the base
 *        tree, so no branch was ever created) -> `failed` (`no_deliverable`
 *        — DEC-0010's "silence plus no deliverable is failure, never
 *        success"). `recoveryEvidence` is never consulted in this branch.
 *      - code_review: a valid block -> `delivered` (`delivery_method:
 *        structured`, no reason); an invalid/absent block -> `delivered`,
 *        reason `prose_fallback` (`delivery_method: prose_fallback`,
 *        DEC-0037) — the chat transcript (`## Worker Report`) is the
 *        deliverable in that case.
 *      - redteam: same block-validity fallback as code_review, but a
 *        crashed/errored worker process (`piResult.outcome` `failed`/
 *        `error`) still fails with reason `process_error` regardless of
 *        block validity — checked FIRST and dominant, so prose fallback
 *        only ever covers a malformed/absent BLOCK from a process that
 *        otherwise ran, never a process that produced no real output at
 *        all (DEC-0010: no worker-authored content can manufacture a
 *        success verdict).
 *      - research: no deliverable block exists for this mode (prose-only,
 *        ruling 1 item 1) — the transcript IS the product (`## Worker
 *        Report`); `delivered` here claims only "the process ran to
 *        completion", never findings quality. A crashed/errored process
 *        still fails.
 */
function deriveVerdict(
  delivery: DeliveryOutcome,
  handoffMode: string,
  piResult?: CaptureOpts['piResult'],
  recoveryEvidence?: RecoveryBlockEvidence,
): VerdictResult {
  if (delivery.status === 'refused_out_of_scope' || delivery.status === 'secret_in_diff') {
    return { outcome: 'refused', reason: delivery.status };
  }
  if (delivery.status === 'conflict') {
    return { outcome: 'failed', reason: 'delivery_conflict' };
  }
  if (delivery.status === 'error') {
    return { outcome: 'failed', reason: 'delivery_error' };
  }
  if (handoffMode === 'implement') {
    if (delivery.status === 'delivered') return { outcome: 'delivered' };
    if (delivery.status === 'no_changes') return { outcome: 'delivered' }; // F1: idempotent redelivery
    if (delivery.status === 'no_delta') return { outcome: 'failed', reason: 'no_deliverable' }; // F2: empty delta
  }
  if (handoffMode === 'code_review') {
    // DEC-0037 (reverses DEC-0023 V4 note 3 for advisory modes; WK-0125):
    // the block is opportunistic, not the deliverable — never hard-fail a
    // genuine review over a JSON shape mismatch.
    if (!recoveryEvidence?.valid) {
      return { outcome: 'delivered', reason: 'prose_fallback', deliveryMethod: 'prose_fallback' };
    }
    return { outcome: 'delivered', deliveryMethod: 'structured' };
  }
  if (handoffMode === 'redteam') {
    // Crash detection is UNCHANGED and dominant (checked before the block-
    // validity fallback) — see the ladder doc comment above.
    if (piResult?.outcome === 'failed' || piResult?.outcome === 'error') {
      return { outcome: 'failed', reason: 'process_error' };
    }
    if (!recoveryEvidence?.valid) {
      return { outcome: 'delivered', reason: 'prose_fallback', deliveryMethod: 'prose_fallback' };
    }
    return { outcome: 'delivered', deliveryMethod: 'structured' };
  }
  if (handoffMode === 'research') {
    if (piResult?.outcome === 'failed' || piResult?.outcome === 'error') {
      return { outcome: 'failed', reason: 'process_error' };
    }
    return { outcome: 'delivered' };
  }
  return { outcome: 'failed', reason: 'unknown_mode' };
}

function describeOutcome(delivery: DeliveryOutcome): string {
  switch (delivery.status) {
    case 'delivered': {
      const base = `Delivered to \`${delivery.branch}\` at commit \`${delivery.commitSha}\`.`;
      if (delivery.ignoredFiles && delivery.ignoredFiles.length > 0) {
        return `${base} Note: ${delivery.ignoredFiles.length} gitignored file(s) under write_scope were skipped: ${delivery.ignoredFiles.join(', ')}.`;
      }
      return base;
    }
    case 'no_changes':
      return 'No changes were delivered (either the worker made none, or this is an idempotent redelivery already landed on the branch).';
    case 'no_delta':
      if (delivery.ignoredFiles && delivery.ignoredFiles.length > 0) {
        return `No changes: worker wrote only gitignored paths (${delivery.ignoredFiles.join(', ')}); delivery's "git add -A" cannot capture them.`;
      }
      return 'No changes: the worker produced no diff from the base tree. No branch was created.';
    case 'refused_out_of_scope':
      return `Refused: changes touched paths outside the declared write_scope (${delivery.offendingPaths.join(', ')}). Diff quarantined at \`${delivery.quarantinePath}\`.`;
    case 'secret_in_diff':
      return `Refused: the diff matched secret pattern(s) (${delivery.patterns.join(', ')}). Diff quarantined at \`${delivery.quarantinePath}\`.`;
    case 'conflict':
      return `Delivery conflict: the branch already carries a different tree from the same base (existing tree \`${delivery.existingTree}\`, new tree \`${delivery.newTree}\`). Nothing was landed.`;
    case 'error':
      return `Delivery error: ${delivery.message}`;
    default: {
      const exhaustiveCheck: never = delivery;
      return exhaustiveCheck;
    }
  }
}

function formatChangedFilesSection(delivery: DeliveryOutcome): string {
  const files = delivery.status === 'delivered' ? delivery.changedFiles : [];
  if (files.length === 0) return '(none)';
  return files.map((file) => `- ${file}`).join('\n');
}

function formatUsageSection(piResult: CaptureOpts['piResult'], billing?: 'seat' | 'api'): string {
  if (!piResult) return '- Tokens: unavailable\n- Cost: unavailable';
  const cost = billing === 'seat' ? 0 : piResult.usage.costUsd;
  return `- Tokens: ${piResult.usage.totalTokens}\n- Cost: $${cost}`;
}

/**
 * Render the `## Worker Report` section body (DEC-0010 diagnosis channel):
 * the worker's final assistant message, embedded VERBATIM as evidence —
 * never parsed, never consulted by `deriveVerdict` above. Absent/empty text
 * (no final message captured at all, e.g. a crashed or empty event stream)
 * renders an explicit placeholder rather than a blank section.
 */
function formatWorkerReportSection(lastAssistantText: string | undefined): string {
  return lastAssistantText && lastAssistantText.length > 0 ? lastAssistantText : '(no final message captured)';
}

/**
 * Render the `## Recovery Signal` section (D1 ruling 1; V4 note 3) from the
 * `kb-dispatch-recovery.v1` evidence extracted from the worker/reviewer/
 * redteam's terminal output block. An absent/invalid block renders a
 * `**Parse failed:**` notice instead of a table, listing every diagnostic
 * `extractRecoveryBlock`/`validateRecoveryPayload` collected — this keeps a
 * missing section from reading as silent success. This rendering is always
 * diagnostic-only from `writeResponseDoc`'s point of view; whether it also
 * drives the run's verdict is `deriveVerdict`'s call (V4 note 3 role
 * asymmetry), not this function's.
 */
function formatRecoveryBlockSection(evidence: RecoveryBlockEvidence): string[] {
  const lines: string[] = ['## Recovery Signal', ''];

  if (!evidence.valid || !evidence.result) {
    const detail = evidence.diagnostics
      .map((d) => `${d.code}: ${d.message}${d.path ? ` (${d.path})` : ''}`)
      .join('; ');
    lines.push(`**Parse failed:** ${detail || 'no diagnostics recorded'}`, '');
    return lines;
  }

  const payload: RecoveryBlockPayload = evidence.result;
  lines.push(`**Reported outcome:** ${payload.reported_outcome}`);
  if (payload.kind) {
    lines.push(`**Kind:** ${payload.kind}`);
  }
  if (payload.summary) {
    lines.push('', payload.summary);
  }

  if (payload.findings.length > 0) {
    lines.push('', '### Findings', '| ID | Severity | Blocking | Title |', '|----|----------|----------|-------|');
    for (const finding of payload.findings) {
      lines.push(`| ${finding.id} | ${finding.severity} | ${finding.blocking ? 'yes' : 'no'} | ${finding.title} |`);
    }
  }

  if (payload.reviewed_controls.length > 0) {
    lines.push('', '### Reviewed Controls', '| Control | Result |', '|---------|--------|');
    for (const control of payload.reviewed_controls) {
      lines.push(`| ${control.control_id} | ${control.result} |`);
    }
  }

  lines.push('');
  return lines;
}

/**
 * Render the `## Mount Writes` section (WK-0164) — a per-mount subsection
 * (mount path as heading) listing the relative file paths the host-side walk
 * found newer than run start. Returns an empty array (nothing rendered) when
 * `mountWrites` is absent/empty.
 */
function formatMountWritesSection(mountWrites: CaptureOpts['mountWrites']): string[] {
  if (!mountWrites || mountWrites.length === 0) return [];
  const lines: string[] = ['## Mount Writes', ''];
  for (const mount of mountWrites) {
    lines.push(`### ${mount.mountPath}`, '');
    if (mount.files.length === 0) {
      lines.push('(none)');
    } else {
      lines.push(...mount.files.map((file) => `- ${file}`));
    }
    lines.push('');
  }
  return lines;
}

/**
 * Serialize a `BackendFingerprint` for the `backend_fingerprint` provenance
 * field. host/model are written even when `serverVersion` is null (no
 * version endpoint for this backend kind, or the probe failed) — losing
 * host/model just because the version half is unprobeable throws away real
 * signal (this was the bug: the caller used to narrow to `serverVersion`
 * alone and drop the whole fingerprint whenever it was null).
 */
function formatBackendFingerprint(fingerprint: BackendFingerprint): string {
  return `${fingerprint.host}|${fingerprint.model}|${fingerprint.serverVersion ?? 'unknown'}`;
}

/**
 * Build the `HO-XXXX.response.md` content and write it into the run dir.
 * Structured frontmatter header (outcome/model/isolation/usage/branch/changed
 * files) followed by a free-form findings body (spec §5).
 */
export async function writeResponseDoc(opts: CaptureOpts): Promise<DispatchResult<CaptureResult>> {
  const { runDir, handoff, delivery, piResult, model, isolationBackend } = opts;

  const verdict = deriveVerdict(delivery, handoff.mode, piResult, opts.recoveryEvidence);
  const branch = deriveBranch(handoff.id, delivery);
  const changedFiles = delivery.status === 'delivered' ? delivery.changedFiles : [];
  const totalTokens = piResult?.usage.totalTokens ?? 0;
  const costUsd = opts.billing === 'seat' ? 0 : (piResult?.usage.costUsd ?? 0);
  const changedFilesYaml = `[${changedFiles.map((file) => JSON.stringify(file)).join(', ')}]`;
  const credentialsGrantedYaml = `[${(opts.credentialsGranted ?? []).map((name) => JSON.stringify(name)).join(', ')}]`;

  const frontmatterLines = [
    '---',
    `handoff_id: ${handoff.id}`,
    `outcome: ${verdict.outcome}`,
    `model: ${model ?? ''}`,
    `isolation_backend: ${isolationBackend ?? ''}`,
    `total_tokens: ${totalTokens}`,
    `cost_usd: ${costUsd}`,
    `branch: ${branch}`,
    `changed_files: ${changedFilesYaml}`,
    `credentials_granted: ${credentialsGrantedYaml}`,
    `effort_requested: ${opts.effort ?? ''}`,
  ];
  if (opts.compaction && opts.compaction.total > 0) {
    frontmatterLines.push(`compaction_total: ${opts.compaction.total}`);
    frontmatterLines.push(`compaction_succeeded: ${opts.compaction.succeeded}`);
    frontmatterLines.push(`compaction_failed: ${opts.compaction.failed}`);
  }
  if (verdict.reason) frontmatterLines.push(`reason: ${verdict.reason}`);
  // WK-0125/DEC-0037: observability for the code_review/redteam
  // structured-vs-prose-fallback fork (never set for implement/research).
  if (verdict.deliveryMethod) frontmatterLines.push(`delivery_method: ${verdict.deliveryMethod}`);
  // Resolved-value provenance (S3 ruling 8): stamped only when the caller has
  // them (e.g. never for the delivery-gate refusal callers, which pass no
  // model/backend at all) — RESOLVED runtime values only, never a template.
  if (opts.baseUrl) frontmatterLines.push(`base_url: ${opts.baseUrl}`);
  if (opts.backend) frontmatterLines.push(`backend: ${opts.backend}`);
  if (opts.piVersion) frontmatterLines.push(`pi_version: ${opts.piVersion}`);
  if (opts.backendFingerprint) frontmatterLines.push(`backend_fingerprint: ${formatBackendFingerprint(opts.backendFingerprint)}`);
  if (opts.wikiCommit) frontmatterLines.push(`wiki_commit: ${opts.wikiCommit}`);
  if (opts.inferenceProvider) frontmatterLines.push(`inference_provider: ${opts.inferenceProvider}`);
  // WK-0166: stamp the recovery evidence merge-delivery needs so it can read
  // frontmatter instead of re-parsing the rendered `## Worker Report` markdown
  // (the regex it used to run stopped at the FIRST `\n## `, which is the
  // worker's own heading when its report starts with one — see WK-0166).
  const recoveryOutcome =
    opts.recoveryEvidence?.valid && opts.recoveryEvidence.result ? opts.recoveryEvidence.result.reported_outcome : '';
  const recoveryValid = opts.recoveryEvidence?.valid ?? false;
  const workerReportChars = (opts.lastAssistantText?.trim() ?? '').length;
  frontmatterLines.push(`recovery_outcome: ${recoveryOutcome}`);
  frontmatterLines.push(`recovery_valid: ${recoveryValid}`);
  frontmatterLines.push(`worker_report_chars: ${workerReportChars}`);
  frontmatterLines.push('---', '');
  const frontmatter = frontmatterLines.join('\n');

  const bodyLines = [
    `# Response: ${handoff.title}`,
    '',
    '## Outcome',
    describeOutcome(delivery),
    '',
    '## Changed Files',
    formatChangedFilesSection(delivery),
    '',
    '## Usage',
    formatUsageSection(piResult, opts.billing),
    '',
    ...formatTokenDetailSection(piResult?.usage, opts.modelId, opts.billing),
    '## Worker Report (evidence, not verdict)',
    '',
    formatWorkerReportSection(opts.lastAssistantText),
    '',
  ];
  if (opts.compaction && opts.compaction.total > 0) {
    bodyLines.push(
      '## Compaction',
      `${opts.compaction.total} compaction events: ${opts.compaction.succeeded} succeeded, ${opts.compaction.failed} failed.`,
      '',
    );
  }
  if (opts.mountWrites && opts.mountWrites.length > 0) {
    bodyLines.push(...formatMountWritesSection(opts.mountWrites));
  }
  if (opts.recoveryEvidence) {
    bodyLines.push(...formatRecoveryBlockSection(opts.recoveryEvidence));
  }
  const body = bodyLines.join('\n');

  const responseContent = `${frontmatter}\n${body}`;
  const responsePath = join(runDir, `${handoff.id}.response.md`);

  try {
    await writeFile(responsePath, responseContent, 'utf8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write response doc to ${responsePath}.`, err);
  }

  return ok({ responsePath, responseContent });
}

/**
 * HO frontmatter provenance fields written back after a run (spec §5's
 * "written back by dispatch after the run" block, minus `status`, which the
 * orchestrator sets separately as part of the broader lifecycle). `run_id`
 * is the run dir's basename — v1's proven convention
 * (`paths.ts`: `.../runs/<handoffId>/RUN-<uuid>/`) that v2 keeps (spec §8
 * capture: "run dirs keep today's proven layout"). `credentials_granted`
 * (S3 T10) is the caller-supplied list of granted profile names — names
 * only, never values — defaulting to `[]` when the caller doesn't pass one
 * (e.g. no credentials were requested).
 */
export function buildProvenanceWriteBack(opts: CaptureOpts): ProvenanceWriteBack {
  const { runDir, handoff, delivery, model, family, isolationBackend } = opts;

  const fields: Record<string, string | boolean | string[]> = {
    run_id: basename(runDir),
    // WK-0136: reflect the actual resolved family when the caller has it
    // (pipeline.ts threads `model.family`); fall back to the model string
    // rather than the old hardcoded 'pi' when family is unavailable.
    agent: family ?? model ?? '',
    model: model ?? '',
    enforced: true,
    isolation_backend: isolationBackend ?? '',
    branch: deriveBranch(handoff.id, delivery),
    response: `${handoff.id}.response.md`,
    credentials_granted: opts.credentialsGranted ?? [],
  };

  // Resolved-value provenance (S3 ruling 8) — same RESOLVED-only invariant as
  // writeResponseDoc above; present only when the caller supplied them.
  if (opts.baseUrl) fields.base_url = opts.baseUrl;
  if (opts.backend) fields.backend = opts.backend;
  if (opts.piVersion) fields.pi_version = opts.piVersion;
  if (opts.backendFingerprint) fields.backend_fingerprint = formatBackendFingerprint(opts.backendFingerprint);
  if (opts.wikiCommit) fields.wiki_commit = opts.wikiCommit;
  if (opts.inferenceProvider) fields.inference_provider = opts.inferenceProvider;
  if (opts.compaction && opts.compaction.total > 0) {
    fields.compaction_total = String(opts.compaction.total);
    fields.compaction_succeeded = String(opts.compaction.succeeded);
    fields.compaction_failed = String(opts.compaction.failed);
  }

  return { fields };
}
