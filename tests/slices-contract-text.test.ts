import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const templateText = fs.readFileSync(path.join(repoRoot, 'contract/templates/issue.md'), 'utf-8');
const plannerText = fs.readFileSync(path.join(repoRoot, 'contract/roles/planner.md'), 'utf-8');
const orchestratorText = fs.readFileSync(path.join(repoRoot, 'contract/roles/orchestrator.md'), 'utf-8');

const SLICES_RULE_PHRASE =
  'in a repo where dispatch is set up, every work item that will be built declares it, one row included; in a wiki-only repo it is optional';
const SLICE_STATUS_SENTENCE =
  '`status` reuses the WK status enum; the orchestrator sets a row to `done` after its slice merges (no tool writes it).';
const PLANNER_SLICE_SIZE_SENTENCE =
  'Keep each slice small enough that one code review covers it thoroughly; split a slice that is not.';
const ORCHESTRATOR_SLICE_SIZE_SENTENCE =
  'A slice is small enough for one code review to cover thoroughly; a slice that is not goes back to planning, it is not split by you.';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('slices contract text', () => {
  // Why: the template named a merge-delivery write and an only-if-it-splits condition that no code enforces.
  it('drops the merge-delivery slice-status claim and the naturally-splits condition', () => {
    expect(templateText).not.toContain('written by merge-delivery');
    expect(templateText).not.toContain('naturally splits');
  });

  // Why: the rule must be pinned in both the body-sections list and the commented example, so a wording edit in either is caught.
  it('states the Slices rule phrase in both the body-sections list and the commented example', () => {
    expect(countOccurrences(templateText, SLICES_RULE_PHRASE)).toBeGreaterThanOrEqual(2);
  });

  // Why: no tool writes a slice row's status, so the template must say the orchestrator sets it after the merge.
  it('says the orchestrator sets a row status after its slice merges', () => {
    expect(templateText).toContain(SLICE_STATUS_SENTENCE);
  });

  // Why: the planner must state the slice-size rule so a slice too big for one review is split before handoff.
  it('carries the slice-size rule in the planner role', () => {
    expect(plannerText).toContain(PLANNER_SLICE_SIZE_SENTENCE);
  });

  // Why: the orchestrator must send an over-large slice back to planning rather than split it itself.
  it('carries the slice-size rule in the orchestrator role', () => {
    expect(orchestratorText).toContain(ORCHESTRATOR_SLICE_SIZE_SENTENCE);
  });
});
