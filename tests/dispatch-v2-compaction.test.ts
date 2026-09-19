/**
 * T33 Phase 3 — compaction event parsing (adapters/pi.ts) and provenance
 * threading (capture.ts).
 *
 * Covers:
 *  - adapters/pi.ts: `parsePiOutput`'s new `compaction: PiCompaction` field
 *    (total/succeeded/failed counts derived from `compaction_end` events),
 *    replacing the deleted `events: unknown[]` field.
 *  - capture.ts: `writeResponseDoc`'s `compaction_total`/`compaction_succeeded`/
 *    `compaction_failed` frontmatter fields and `## Compaction` body section,
 *    rendered only when at least one compaction event occurred.
 *
 * Golden fixture: `tests/fixtures/pi-output-compaction.jsonl` — a real,
 * unedited capture (HO-0007 RUN-464b1cc0) carrying 11 compaction_start/
 * compaction_end pairs, all successful. The one hand-authored fixture below
 * (compaction failure) mutates the real `compaction_end` shape captured from
 * that same file (drops `result`, adds `errorMessage`) rather than inventing
 * a shape from memory. No personal/absolute paths appear in this file (WK-0043
 * rule) — the golden fixture path is resolved relative to this test file via
 * `__dirname` (this file compiles to CommonJS under NodeNext — no
 * package.json `"type": "module"` — so `import.meta.url` is not usable
 * here), and all `writeResponseDoc` tests use temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePiOutput } from '../packages/dispatch-core/src/adapters/pi.js';
import { writeResponseDoc } from '../packages/dispatch-core/src/capture.js';
import type { DeliveryOutcome } from '../packages/dispatch-core/src/delivery.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// adapters/pi.ts — compaction counting, golden fixture
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — compaction event parsing (T33 Phase 3, golden fixture)', () => {
  const fixturePath = join(__dirname, 'fixtures', 'pi-output-compaction.jsonl');
  const fixtureContent = readFileSync(fixturePath, 'utf8');

  it('counts 11 compaction_start/compaction_end pairs, all successful, and drops the events field', () => {
    const result = parsePiOutput(fixtureContent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.compaction.total).toBe(11);
    expect(result.data.compaction.succeeded).toBe(11);
    expect(result.data.compaction.failed).toBe(0);
    expect(result.data.outcome).toBe('completed');
    expect(result.data.hasAgentEnd).toBe(true);
    expect(result.data.usage.totalTokens).toBeGreaterThan(0);
    expect(result.data.lastAssistantText.length).toBeGreaterThan(0);
    expect('events' in result.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// adapters/pi.ts — compaction counting, hand-authored edge cases. The failure
// event mutates the real compaction_end shape (see fixture line 62): result
// removed, errorMessage added — the one allowed hand-authored case per
// evidence-discipline rules (mutating a real capture, not inventing a shape).
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — compaction event parsing (hand-authored edge cases)', () => {
  it('counts a failed compaction_end (no result, errorMessage present) separately from a succeeded one', () => {
    const lines = [
      JSON.stringify({ type: 'agent_start' }),
      // Succeeded shape, mirroring the real fixture's compaction_end (result present, aborted: false).
      JSON.stringify({
        type: 'compaction_end',
        reason: 'threshold',
        result: { summary: 'test summary' },
        aborted: false,
        willRetry: false,
      }),
      // Failed shape: mutated from the same real event — result dropped, errorMessage added.
      JSON.stringify({
        type: 'compaction_end',
        reason: 'threshold',
        errorMessage: 'test error',
        aborted: false,
        willRetry: false,
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.compaction.total).toBe(2);
    expect(result.data.compaction.succeeded).toBe(1);
    expect(result.data.compaction.failed).toBe(1);
  });

  it('reports zero compaction stats when the stream carries no compaction events', () => {
    const lines = [
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 10, cost: { total: 0.0001 } } },
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.compaction.total).toBe(0);
    expect(result.data.compaction.succeeded).toBe(0);
    expect(result.data.compaction.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// capture.ts — ## Compaction section + frontmatter rendering
// ---------------------------------------------------------------------------

describe('capture.ts — compaction provenance rendering (T33 Phase 3)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await createTempDir('kb-capture-compaction-');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const handoff = { id: 'HO-TEST', title: 'Test task', mode: 'implement' };
  const delivery: DeliveryOutcome = { status: 'no_changes' };

  it('renders compaction frontmatter fields and a ## Compaction body section when compaction occurred', async () => {
    const result = await writeResponseDoc({
      runDir,
      handoff,
      delivery,
      compaction: { total: 5, succeeded: 4, failed: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.responseContent).toContain('compaction_total: 5');
    expect(result.data.responseContent).toContain('compaction_succeeded: 4');
    expect(result.data.responseContent).toContain('compaction_failed: 1');
    expect(result.data.responseContent).toContain('## Compaction');
    expect(result.data.responseContent).toContain('5 compaction events: 4 succeeded, 1 failed');
  });

  it('omits compaction frontmatter and the ## Compaction section when no compaction occurred', async () => {
    const result = await writeResponseDoc({ runDir, handoff, delivery });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.responseContent).not.toContain('compaction_total');
    expect(result.data.responseContent).not.toContain('## Compaction');
  });
});
