/**
 * PLN-0004 S1 Wave 2b — T7-full closure tests.
 *
 * Covers provenance write-back into HO frontmatter (T7-full closure item 3,
 * `wiki/plans/PLN-0004/execution/s1-rulings.md`) via the
 * `mergeProvenanceFrontmatter` merge helper pipeline.ts wires it through.
 * (T7-full closure item 1, `needs:` parsing/round-trip, was retired outright
 * by DEC-0010/WK-0095 — the worker's self-reported needs are no longer
 * consulted by anything; item 2, the canonical response-doc copy, requires
 * the full WSL2/bwrap/Pi chain and is covered in tests/dispatch-v2-e2e.test.ts.)
 *
 * capture.ts's pre-existing writeResponseDoc/buildProvenanceWriteBack
 * coverage (delivered/refused/secret/no-op outcomes) lives in
 * tests/dispatch-v2-delivery.test.ts and is not duplicated here.
 */
import { describe, expect, it } from 'vitest';

import { mergeProvenanceFrontmatter } from '../packages/dispatch-core/src/pipeline.js';

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
