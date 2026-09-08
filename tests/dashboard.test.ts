import { describe, it, expect } from 'vitest';
import { parseTracker } from '../packages/dashboard/src/parse-tracker.js';
import { laneOf, summarize, parseFrontmatter, sourceLatestDate } from '../packages/dashboard/src/util.js';

const MINIMAL_TRACKER = `
## Phase Status Table

| Slice (phase) | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S0 | done | 2026-01-01 | 2026-01-02 | |
| S1 | in_progress | 2026-01-03 | | |
| S2 | not_started | | | |

## Gates

- [x] **S0 gate (skeleton)**
- [ ] **S1 gate (orchestrate)**

## Task-to-Phase Mapping

| Task | Slice (phase) | Description | user_interaction |
|------|-------|-------------|------------------|
| T1 | S0 | Setup baseline | none |
| T2 | S0 (lite), S1 (full) | Feature alpha | none |
| T3 | S1 | Feature beta | none |
| T4 | S2 | Future work | none |

## Completed Log

| Date | Task | Summary |
|------|------|---------|
| 2026-01-02 | T1 | Done |

## Failure Log
`;

describe('dashboard', () => {
  describe('parseTracker', () => {
    const data = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });

    it('parses phases from Phase Status Table', () => {
      expect(data.phases).toHaveLength(3);
      expect(data.phases[0].id).toBe('S0');
      expect(data.phases[0].lane).toBe('done');
      expect(data.phases[1].id).toBe('S1');
      expect(data.phases[1].lane).toBe('in_progress');
    });

    it('lifts gate labels from parentheticals', () => {
      expect(data.phases[0].label).toBe('skeleton');
      expect(data.phases[1].label).toBe('orchestrate');
    });

    it('assigns tasks to phases', () => {
      expect(data.phases[0].tasks.map(t => t.id)).toContain('T1');
      expect(data.phases[1].tasks.map(t => t.id)).toContain('T3');
    });

    it('produces deterministic output', () => {
      const a = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });
      const b = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe('taskMatrix', () => {
    const data = parseTracker(MINIMAL_TRACKER, { id: 'PLN-TEST', title: 'Test', status: 'active' });
    const mx = data.taskMatrix!;

    it('builds matrix with correct columns', () => {
      expect(mx.columns).toEqual(['S0', 'S1', 'S2']);
    });

    it('single-phase tasks have one active cell', () => {
      const t1 = mx.rows.find(r => r.taskId === 'T1')!;
      expect(t1.cells).toEqual(['NEW', '', '']);
    });

    it('multi-phase tasks show scope and carried-forward', () => {
      const t2 = mx.rows.find(r => r.taskId === 'T2')!;
      expect(t2.cells).toEqual(['lite', 'full', '']);
    });

    it('extracts station phrase from description', () => {
      const t2 = mx.rows.find(r => r.taskId === 'T2')!;
      expect(t2.station).toBe('Feature alpha');
    });

    it('sorts rows by first appearance', () => {
      expect(mx.rows[0].taskId).toBe('T1');
      expect(mx.rows[mx.rows.length - 1].taskId).toBe('T4');
    });
  });

  describe('carried-forward dot logic', () => {
    const GAPPED = `
## Phase Status Table

| Slice (phase) | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S0 | done | | | |
| S1 | done | | | |
| S2 | done | | | |
| S3 | not_started | | | |

## Gates

## Task-to-Phase Mapping

| Task | Slice (phase) | Description | user_interaction |
|------|-------|-------------|------------------|
| T1 | S0 (min), S3 (full) | Gapped task | none |

## Completed Log

## Failure Log
`;
    const data = parseTracker(GAPPED, { id: 'PLN-GAP', title: 'Gap', status: 'active' });
    const t1 = data.taskMatrix!.rows.find(r => r.taskId === 'T1')!;

    it('fills carried-forward dots between first and last active phase', () => {
      expect(t1.cells).toEqual(['min', '·', '·', 'full']);
    });
  });

  describe('util', () => {
    it('laneOf maps statuses correctly', () => {
      expect(laneOf('done', false)).toBe('done');
      expect(laneOf('in_progress', false)).toBe('in_progress');
      expect(laneOf('not_started', false)).toBe('queued');
      expect(laneOf('in_progress', true)).toBe('blocked');
      expect(laneOf('done', true)).toBe('done');
      expect(laneOf('inbox', true)).toBe('queued');
      expect(laneOf('blocked', false)).toBe('blocked');
    });

    it('summarize counts lanes', () => {
      const s = summarize(['done', 'done', 'in_progress', 'blocked']);
      expect(s).toEqual({ done: 2, inProgress: 1, blocked: 1, queued: 0, total: 4 });
    });

    it('parseFrontmatter handles CRLF', () => {
      const fm = parseFrontmatter('---\r\ntitle: "Test"\r\nstatus: done\r\n---\r\n');
      expect(fm['title']).toBe('Test');
      expect(fm['status']).toBe('done');
    });

    it('sourceLatestDate extracts latest date', () => {
      expect(sourceLatestDate('started 2026-01-01, completed 2026-03-15')).toBe('2026-03-15');
      expect(sourceLatestDate('no dates here')).toBe('');
    });
  });
});
