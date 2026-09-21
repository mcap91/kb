/**
 * WK-0131 step 5 — fake-tier tests for the Claude settings.json permission
 * fix: `buildClaudeSettingsJson` (pipeline.ts) emitting relative Edit paths
 * and a correctly-prefixed Read entry, its write_scope validation, and
 * `runClaudePermissionProbe`'s (claude-probe.ts) empty-scope short-circuit.
 * Pure/synchronous throughout except the probe's own no-op path — no real
 * `claude` process is spawned here. No personal/absolute paths in fixtures
 * (WK-0043 rule); clonePath below is synthetic.
 */
import { describe, expect, it } from 'vitest';

import { buildClaudeSettingsJson } from '../packages/dispatch-core/src/pipeline.js';
import { runClaudePermissionProbe } from '../packages/dispatch-core/src/claude-probe.js';

const clonePath = '/some/clone/path';

// ---------------------------------------------------------------------------
// buildClaudeSettingsJson — relative Edit paths (WK-0131 step 1)
// ---------------------------------------------------------------------------

describe('buildClaudeSettingsJson — relative Edit paths', () => {
  it('emits relative Edit(...) entries for directory write_scope entries, no absolute paths, and a Bash allow entry', () => {
    const settings = JSON.parse(buildClaudeSettingsJson(['src/', 'test/'], clonePath, 'implement'));
    const allow: string[] = settings.permissions.allow;

    expect(allow).toContain('Edit(src/**)');
    expect(allow).toContain('Edit(test/**)');
    expect(allow.some((entry) => entry.startsWith('Edit(/'))).toBe(false);
    expect(allow).toContain('Bash');
  });
});

// ---------------------------------------------------------------------------
// buildClaudeSettingsJson — Read prefix fix (WK-0131 step 2)
// ---------------------------------------------------------------------------

describe('buildClaudeSettingsJson — Read entry prefix', () => {
  it('produces a Read(//<clonePath>/**) entry with exactly two leading slashes', () => {
    const settings = JSON.parse(buildClaudeSettingsJson(['src/'], clonePath, 'implement'));
    const allow: string[] = settings.permissions.allow;
    const readEntry = allow.find((entry) => entry.startsWith('Read('));

    expect(readEntry).toBeDefined();
    expect(readEntry).toMatch(/^Read\(\/\/[^/]/);
  });
});

// ---------------------------------------------------------------------------
// buildClaudeSettingsJson — scope validation (WK-0131 step 1)
// ---------------------------------------------------------------------------

describe('buildClaudeSettingsJson — scope validation', () => {
  it('rejects an absolute write_scope entry', () => {
    expect(() => buildClaudeSettingsJson(['/absolute/path'], clonePath, 'implement')).toThrow();
  });

  it('rejects a write_scope entry containing ".."', () => {
    expect(() => buildClaudeSettingsJson(['../escape'], clonePath, 'implement')).toThrow();
  });

  it('rejects an empty write_scope in mode "implement"', () => {
    expect(() => buildClaudeSettingsJson([], clonePath, 'implement')).toThrow();
  });

  it('accepts an empty write_scope in an advisory mode (code_review)', () => {
    expect(() => buildClaudeSettingsJson([], clonePath, 'code_review')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runClaudePermissionProbe — empty write_scope short-circuit (WK-0131 step 4)
// ---------------------------------------------------------------------------

describe('runClaudePermissionProbe', () => {
  it('returns ok(undefined) without spawning when write_scope is empty', async () => {
    const result = await runClaudePermissionProbe('{}', []);
    expect(result).toEqual({ ok: true, data: undefined });
  });

  // Full probe integration tested via S6c gate (live dispatch)
});
