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
