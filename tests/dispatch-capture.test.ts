/**
 * PLN-0004 S1 Wave 2b — T7-full closure tests.
 *
 * Covers the three previously-unwired T7 capture items named in
 * `wiki/plans/PLN-0004/execution/s1-rulings.md` ("T7-full closure"):
 * 1. `needs:` parsing from Pi's own text output (adapters/pi.ts) and its
 *    round-trip into the response doc (capture.ts).
 * 2. The canonical `wiki/handoffs/HO-XXXX.response.md` copy — wired in
 *    pipeline.ts's `runDispatch()`, which requires the full WSL2/bwrap/Pi
 *    chain to exercise end-to-end (see tests/dispatch-v2-e2e.test.ts); not
 *    re-tested here.
 * 3. Provenance write-back into HO frontmatter — this suite covers the
 *    `mergeProvenanceFrontmatter` merge helper pipeline.ts wires it through.
 *
 * capture.ts's pre-existing writeResponseDoc/buildProvenanceWriteBack
 * coverage (delivered/refused/secret/no-op outcomes) lives in
 * tests/dispatch-v2-delivery.test.ts and is not duplicated here. No
 * personal/absolute paths appear in fixtures (WK-0043 rule); filesystem
 * tests use temp dirs.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeResponseDoc } from '../packages/dispatch-core/src/capture.js';
import type { DeliveryOutcome } from '../packages/dispatch-core/src/delivery.js';
import { parsePiOutput } from '../packages/dispatch-core/src/adapters/pi.js';
import { mergeProvenanceFrontmatter } from '../packages/dispatch-core/src/pipeline.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// capture.ts — writeResponseDoc `needs` round-trip
// ---------------------------------------------------------------------------

describe('capture.ts — writeResponseDoc needs handling', () => {
  let runDir: string | undefined;
  const delivery: DeliveryOutcome = { status: 'no_changes' };

  afterEach(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  it('round-trips needs into frontmatter and a body section', async () => {
    runDir = await createTempDir('kb-capture-needs-');

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0020', title: 'Widen scope test', mode: 'implement' },
      delivery,
      piResult: { outcome: 'blocked', usage: { totalTokens: 10, costUsd: 0.0001 } },
      needs: ['wider scope', 'data access'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { responseContent } = result.data;
    expect(responseContent).toContain('needs: ["wider scope", "data access"]');
    expect(responseContent).toContain('## Needs');
    expect(responseContent).toContain('- wider scope');
    expect(responseContent).toContain('- data access');
  });

  it('omits both the frontmatter field and body section when needs is empty', async () => {
    runDir = await createTempDir('kb-capture-no-needs-');

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0021', title: 'No needs test', mode: 'implement' },
      delivery,
      needs: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.responseContent).not.toContain('needs:');
    expect(result.data.responseContent).not.toContain('## Needs');
  });

  it('omits needs when the field is not passed at all', async () => {
    runDir = await createTempDir('kb-capture-undefined-needs-');

    const result = await writeResponseDoc({
      runDir,
      handoff: { id: 'HO-0022', title: 'Undefined needs test', mode: 'implement' },
      delivery,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.responseContent).not.toContain('needs:');
    expect(result.data.responseContent).not.toContain('## Needs');
  });
});

// ---------------------------------------------------------------------------
// pipeline.ts — mergeProvenanceFrontmatter
// ---------------------------------------------------------------------------

describe('pipeline.ts — mergeProvenanceFrontmatter', () => {
  const SAMPLE_HO = [
    '---',
    'id: HO-0004',
    'title: Add a truncate utility with node:test coverage',
    'mode: implement',
    'write_scope: ["src/", "test/"]',
    'base_ref: null',
    'web: false',
    'credentials: []',
    'data_mounts: []',
    'read_first: ["README.md"]',
    'acceptance:',
    '  - "AC-1: example"',
    'validation: ["node --test test/"]',
    'status: draft',
    '---',
    '',
    '## Context',
    'Some task body text that must survive untouched.',
    '',
  ].join('\n');

  const FIRST_RUN_FIELDS: Record<string, string | boolean | string[]> = {
    run_id: 'RUN-first',
    agent: 'pi',
    model: 'deepseek/deepseek-v4-flash-0731',
    enforced: true,
    isolation_backend: 'bwrap-wsl2',
    branch: 'dispatch/HO-0004',
    response: 'HO-0004.response.md',
    credentials_granted: [],
  };

  it('appends provenance fields before the closing --- when none exist yet', () => {
    const updated = mergeProvenanceFrontmatter(SAMPLE_HO, FIRST_RUN_FIELDS);

    expect(updated).toContain('run_id: RUN-first');
    expect(updated).toContain('agent: pi');
    expect(updated).toContain('model: deepseek/deepseek-v4-flash-0731');
    expect(updated).toContain('enforced: true');
    expect(updated).toContain('isolation_backend: bwrap-wsl2');
    expect(updated).toContain('branch: dispatch/HO-0004');
    expect(updated).toContain('response: HO-0004.response.md');
    expect(updated).toContain('credentials_granted: []');

    // Original fields and body untouched
    expect(updated).toContain('id: HO-0004');
    expect(updated).toContain('status: draft');
    expect(updated).toContain('## Context');
    expect(updated).toContain('Some task body text that must survive untouched.');

    // Appended after the original fields, before the closing ---
    const frontmatterEnd = updated.indexOf('\n---\n', updated.indexOf('id: HO-0004'));
    const runIdIndex = updated.indexOf('run_id: RUN-first');
    expect(runIdIndex).toBeGreaterThan(updated.indexOf('status: draft'));
    expect(runIdIndex).toBeLessThan(frontmatterEnd);
  });

  it('replaces existing provenance fields in place on a second merge (no duplicate lines)', () => {
    const afterFirstRun = mergeProvenanceFrontmatter(SAMPLE_HO, FIRST_RUN_FIELDS);

    const secondRunFields: Record<string, string | boolean | string[]> = {
      ...FIRST_RUN_FIELDS,
      run_id: 'RUN-second',
      needs: ['wider write_scope to include config/'],
    };
    const afterSecondRun = mergeProvenanceFrontmatter(afterFirstRun, secondRunFields);

    // Only one run_id line, carrying the new value
    const runIdMatches = afterSecondRun.match(/run_id:/g) ?? [];
    expect(runIdMatches).toHaveLength(1);
    expect(afterSecondRun).toContain('run_id: RUN-second');
    expect(afterSecondRun).not.toContain('RUN-first');

    // Newly-introduced field appended
    expect(afterSecondRun).toContain('needs: ["wider write_scope to include config/"]');

    // Body still untouched
    expect(afterSecondRun).toContain('Some task body text that must survive untouched.');
  });

  it('returns content unchanged when no frontmatter block is found', () => {
    const noFrontmatter = 'Just a plain markdown file, no frontmatter.\n';
    const result = mergeProvenanceFrontmatter(noFrontmatter, { run_id: 'RUN-x' });
    expect(result).toBe(noFrontmatter);
  });
});

// ---------------------------------------------------------------------------
// adapters/pi.ts — parsePiOutput needs extraction
// ---------------------------------------------------------------------------

describe('adapters/pi.ts — parsePiOutput needs extraction', () => {
  it('parses a ## Needs section accumulated across text_delta events', () => {
    const lines = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'text_delta', message: { content: 'Ran into a scope wall.\n\n## Needs\n' } }),
      JSON.stringify({ type: 'text_delta', message: { content: '- foo\n- bar\n' } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { totalTokens: 20, cost: { total: 0.0002 } } },
      }),
      JSON.stringify({ type: 'turn_end', stopReason: 'end_turn' }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needs).toEqual(['foo', 'bar']);
  });

  it('returns an empty needs array when no ## Needs section is present', () => {
    const lines = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'text_delta', message: { content: 'All done, nothing needed.' } }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const result = parsePiOutput(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needs).toEqual([]);
  });
});
