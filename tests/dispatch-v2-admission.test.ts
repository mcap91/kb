/**
 * PLN-0004 S4 Wave 2 — tests for the NEW S4 admission-gate refusal codes.
 *
 * Wave 1 implemented the full §7 admission gate (13 checks — §7.11
 * `no_isolation_route` deferred to S5, per the 2026-09-11 tracker ruling) in
 * admission.ts, plus the mode-restriction removal in ho.ts and the
 * `tokenEstimate` field in assemble.ts that backs pipeline.ts's
 * `CONTEXT_BUDGET_EXCEEDED` gate. This file tests only the codes that are new
 * at S4; the S0 codes (`BAD_RECORD`, `MISSING_WRITE_SCOPE`, `DIRTY_REPO`) are
 * already covered in dispatch-v2-foundation.test.ts and are exercised here
 * only where an S4 check specifically needs to be proven to still work
 * end-to-end through the fuller gate (item 7 below). No personal/absolute
 * paths appear in fixtures (WK-0043 rule); all filesystem tests use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHandoffContent, type Handoff } from '../packages/dispatch-core/src/ho.js';
import { checkAdmission } from '../packages/dispatch-core/src/admission.js';
import { assemblePrompt } from '../packages/dispatch-core/src/assemble.js';

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'HO-0002',
    title: 'Add a slugify utility with node:test coverage',
    mode: 'implement',
    write_scope: ['src/', 'test/'],
    base_ref: null,
    web: false,
    credentials: [],
    data_mounts: [],
    read_first: ['README.md'],
    vars: [],
    acceptance: ['AC-1: example'],
    validation: ['node --test test/'],
    status: 'draft',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// admission.ts — S4 new refusal codes
// ---------------------------------------------------------------------------

describe('admission.ts — S4 full admission gate (new refusal codes)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dispatch-s4-'));
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    await writeFile(join(tempDir, 'README.md'), '# test');
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, 'test'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ENVELOPE_EXCEEDS_MODE (§7.2)', () => {
    it('refuses a code_review handoff that declares a non-empty write_scope', async () => {
      const result = await checkAdmission(makeHandoff({ mode: 'code_review' }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('ENVELOPE_EXCEEDS_MODE');
      expect(result.message).toContain('write_scope');
    });

    it('refuses a redteam handoff that requests web:true', async () => {
      // write_scope must be cleared here so the write_scope ceiling branch
      // (checked first in checkEnvelope) does not mask the web-ceiling branch
      // this test is targeting.
      const result = await checkAdmission(makeHandoff({ mode: 'redteam', web: true, write_scope: [] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('ENVELOPE_EXCEEDS_MODE');
      expect(result.message).toContain('web:true');
    });
  });

  describe('STALE_WRITE_SCOPE (§7.3)', () => {
    it('refuses a write_scope entry that escapes the repo root', async () => {
      const result = await checkAdmission(makeHandoff({ write_scope: ['../../etc'] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('STALE_WRITE_SCOPE');
      expect(result.message).toContain('outside the repo root');
    });

    it('refuses a write_scope entry whose path and parent directory both do not exist', async () => {
      const result = await checkAdmission(makeHandoff({ write_scope: ['deeply/nested/path'] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('STALE_WRITE_SCOPE');
      expect(result.message).toContain('neither does its parent directory');
    });
  });

  describe('MISSING_READ_FIRST (§7.5)', () => {
    it('refuses a read_first entry pointing to a file that does not exist', async () => {
      const result = await checkAdmission(makeHandoff({ read_first: ['MISSING.md'] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_READ_FIRST');
      expect(result.message).toContain('read_first entry');
    });
  });

  describe('BAD_BASE_REF (§7.12)', () => {
    it('refuses a base_ref that does not start with "dispatch/"', async () => {
      const result = await checkAdmission(makeHandoff({ base_ref: 'feature/foo' }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_BASE_REF');
      expect(result.message).toContain('not dispatch-owned');
    });

    it('refuses a base_ref that starts with "dispatch/" but does not exist in the repo', async () => {
      const result = await checkAdmission(makeHandoff({ base_ref: 'dispatch/HO-9999' }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_BASE_REF');
      expect(result.message).toContain('does not exist in');
    });
  });

  describe('BAD_DATA_MOUNT (§7.14)', () => {
    it('refuses a data_mounts entry that is a relative path', async () => {
      const result = await checkAdmission(makeHandoff({ data_mounts: ['relative/path'] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_DATA_MOUNT');
      expect(result.message).toContain('not an absolute path');
    });

    it('refuses a data_mounts entry that does not exist on disk', async () => {
      const missingMount = join(tmpdir(), `kb-admission-missing-mount-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const result = await checkAdmission(makeHandoff({ data_mounts: [missingMount] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_DATA_MOUNT');
      expect(result.message).toContain('does not exist on disk');
    });

    it('refuses a data_mounts entry that resolves inside the repo root', async () => {
      // tempDir is the temp git repo path itself — an absolute, existing path
      // that trivially resolves inside the repo root (WK-0043: no personal paths).
      const result = await checkAdmission(makeHandoff({ data_mounts: [tempDir] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_DATA_MOUNT');
      expect(result.message).toContain('inside the repo root');
    });
  });

  describe('MISSING_WRITE_SCOPE — S4 gate still catches deliberately under-specified HOs', () => {
    it('refuses an implement handoff with an empty write_scope through the full 13-check gate', async () => {
      const result = await checkAdmission(makeHandoff({ write_scope: [] }), tempDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('MISSING_WRITE_SCOPE');
      expect(result.message).toContain('write_scope');
    });
  });
});

// ---------------------------------------------------------------------------
// assemble.ts — tokenEstimate (the testable unit backing pipeline.ts's
// §7.13 CONTEXT_BUDGET_EXCEEDED gate; the gate's own comparison against
// model.contextWindow is trivial arithmetic in pipeline.ts and is not
// reachable through checkAdmission).
// ---------------------------------------------------------------------------

describe('assemble.ts — tokenEstimate backs the §7.13 context_budget_exceeded gate', () => {
  let repoRoot: string;

  const HO_CONTENT = `---
id: HO-0002
title: Minimal handoff for tokenEstimate proportionality check
mode: implement
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: ["README.md"]
acceptance:
  - "AC-1: placeholder acceptance criterion"
validation: ["true"]
status: draft
---

## Context
Minimal context body for the S4 tokenEstimate proportionality test.
`;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'dispatch-s4-assemble-'));
    await mkdir(join(repoRoot, 'wiki', 'handoffs'), { recursive: true });
    await writeFile(join(repoRoot, 'wiki', 'handoffs', 'HO-0002.md'), HO_CONTENT, 'utf8');
    await writeFile(join(repoRoot, 'README.md'), 'short read_first content\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('returns a positive tokenEstimate that scales with the assembled text length', async () => {
    const parsed = parseHandoffContent(HO_CONTENT, 'HO-0002.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const shortResult = await assemblePrompt(parsed.data, repoRoot);
    expect(shortResult.ok).toBe(true);
    if (!shortResult.ok) return;
    expect(shortResult.data.tokenEstimate).toBeGreaterThan(0);
    expect(shortResult.data.tokenEstimate).toBe(Math.ceil(shortResult.data.text.length / 4));

    // Grow the read_first file substantially and reassemble: the estimate
    // must grow in proportion to the assembled text length, not stay fixed.
    await writeFile(join(repoRoot, 'README.md'), `${'x'.repeat(4000)}\n`, 'utf8');
    const longResult = await assemblePrompt(parsed.data, repoRoot);
    expect(longResult.ok).toBe(true);
    if (!longResult.ok) return;
    expect(longResult.data.tokenEstimate).toBeGreaterThan(shortResult.data.tokenEstimate);
    expect(longResult.data.tokenEstimate).toBe(Math.ceil(longResult.data.text.length / 4));
  });
});

// ---------------------------------------------------------------------------
// ho.ts — S0 mode restriction removed at S4: all four §6 modes parse
// ---------------------------------------------------------------------------

describe('ho.ts — S4: mode restriction removed, all four §6 modes parse', () => {
  const MINIMAL_HO_CONTENT = `---
id: HO-0002
title: Minimal handoff for mode-parsing checks
mode: implement
write_scope: ["src/"]
base_ref: null
web: false
credentials: []
data_mounts: []
read_first: []
acceptance:
  - "AC-1: placeholder"
validation: ["true"]
status: draft
---

## Context
Minimal body — only frontmatter schema parsing is under test here.
`;

  it.each(['implement', 'code_review', 'redteam', 'research'] as const)(
    'accepts mode: %s as valid frontmatter',
    (mode) => {
      const content = MINIMAL_HO_CONTENT.replace('mode: implement', `mode: ${mode}`);
      const result = parseHandoffContent(content, 'HO-0002.md');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.mode).toBe(mode);
    },
  );
});
