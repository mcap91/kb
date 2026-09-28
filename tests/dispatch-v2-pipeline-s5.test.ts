/**
 * PLN-0004 S5 Wave 2 — pipeline.ts `buildPiBaseUrl` coverage.
 *
 * D6 Phase 2 (mid_project_review_rulings.md ruling 7) deleted
 * `buildExecutionScript`/`BuildExecutionScriptOpts` (the generated-script
 * assembly the direct-spawn pipeline replaces) and
 * `toJailDataMount`/`needsWinHostResolution`/`applyWinHost` (Windows/WSL2
 * path-conversion and WIN_HOST resolution helpers — dead post-D3's
 * Linux-only orchestrator). This file's coverage of those functions was
 * removed along with them; `buildPiBaseUrl` is the one pure helper from this
 * suite that survives D6 unchanged (the tunnel relay's in-jail loopback
 * baseUrl rewrite is still needed). Phase 3 owns any replacement coverage
 * for the D6 spawn pipeline itself (dispatch-v2-exec.test.ts's rewrite, per
 * the ruling's own "Tests" section).
 */
import { describe, expect, it } from 'vitest';

import { buildPiBaseUrl } from '../packages/dispatch-core/src/pipeline.js';
import { extractRecoveryBlock, REPORTED_ROLES } from '../packages/dispatch-core/src/recovery-block.js';
import { TUNNEL_RELAY_PORT } from '../packages/dispatch-core/src/tunnel.js';

// ---------------------------------------------------------------------------
// buildPiBaseUrl — S6a fix: Pi's own baseUrl must preserve the operator's
// configured path (`/v1` for Ollama, `/api/v1` for OpenRouter — both shapes
// documented in init-dispatch.ts's backends.json README) when it gets
// rewritten to the in-jail loopback relay origin. Pi constructs API requests
// relative to baseUrl, so dropping the path sent every request to the bare
// route instead of the operator's real one — 404 from Ollama, errors from
// OpenRouter (the live S6a gate-2 bug, 2026-09-13). Pure/synchronous.
// ---------------------------------------------------------------------------

describe('buildPiBaseUrl — preserves the operator-configured baseUrl path (S6a gate-2 fix)', () => {
  it('preserves the /v1 path from an Ollama-style baseUrl', () => {
    expect(buildPiBaseUrl('http://127.0.0.1:11434/v1')).toBe(`http://127.0.0.1:${TUNNEL_RELAY_PORT}/v1`);
  });

  it('preserves the /api/v1 path from an OpenRouter-style baseUrl', () => {
    expect(buildPiBaseUrl('https://openrouter.ai/api/v1')).toBe(`http://127.0.0.1:${TUNNEL_RELAY_PORT}/api/v1`);
  });

  it('handles a baseUrl with no path (bare http://host:port) as an empty path, not a crash', () => {
    expect(buildPiBaseUrl('http://host:1234')).toBe(`http://127.0.0.1:${TUNNEL_RELAY_PORT}`);
  });

  it('strips a trailing slash (http://host:port/v1/) so the rebuilt URL never double-slashes', () => {
    expect(buildPiBaseUrl('http://host:1234/v1/')).toBe(`http://127.0.0.1:${TUNNEL_RELAY_PORT}/v1`);
  });
});

// ---------------------------------------------------------------------------
// HO-0041 (WK-0146): pipeline.ts no longer mode-gates `kb-dispatch-recovery.v1`
// extraction to skip `research` — extraction now runs for every mode's worker
// output, same as implement/code_review/redteam (see pipeline.ts's
// `recoveryEvidence` assignment, no longer `handoff.mode === 'research' ?
// undefined : extractRecoveryBlock(...)`). A research worker's block uses
// `reported_role: "researcher"` (assemble.ts's `RESEARCH_RESPONSE_FORMAT`,
// WK-0145), which recovery-block.ts must accept. `pipeline.ts` itself has no
// exported seam for its inline extraction call, so this coverage exercises
// the same `extractRecoveryBlock`/`REPORTED_ROLES` surface pipeline.ts now
// calls unconditionally, for the role research output actually uses.
// ---------------------------------------------------------------------------

describe('recovery-block.ts — researcher role (HO-0041/WK-0146: research mode extraction is no longer skipped)', () => {
  it('REPORTED_ROLES includes researcher', () => {
    expect(REPORTED_ROLES).toContain('researcher');
  });

  it('extracts and validates a research worker output that includes a valid recovery block (reported_role: researcher)', () => {
    const payload = {
      schema_version: 'kb-dispatch-recovery.v1',
      reported_role: 'researcher',
      reported_subject: 'HO-0041',
      reported_outcome: 'no_findings',
      summary: 'Investigated the question; no notable findings.',
      findings: [],
      finding_counts: { total: 0, blocking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      reviewed_controls: [],
    };
    const text =
      'Findings and sources go here.\n\n' +
      '```kb-dispatch-recovery.v1\n' +
      JSON.stringify(payload, null, 2) +
      '\n```';

    const evidence = extractRecoveryBlock(text);

    expect(evidence.valid).toBe(true);
    expect(evidence.result?.reported_role).toBe('researcher');
    expect(evidence.result?.reported_outcome).toBe('no_findings');
  });

  it('research worker output without a recovery block still yields a non-throwing evidence envelope (block is optional; the run is not gated on it)', () => {
    const text = 'Findings and sources go here, but the worker never emitted a recovery block.';

    const evidence = extractRecoveryBlock(text);

    expect(evidence.valid).toBe(false);
    expect(evidence.diagnostics.map((d) => d.code)).toContain('missing_result');
    expect(evidence.authority).toBe('child_evidence_only');
  });
});
