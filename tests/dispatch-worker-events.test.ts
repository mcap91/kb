/**
 * WK-0153 — `parseWorkerEvents`: projects a run bundle's `worker-output.log`
 * into turn count, last activity, and files touched for `status` enrichment
 * of active v2 runs.
 *
 * Event shapes are evidence-gated (DEC-0009): codex and claude fixtures below
 * reproduce the literal lines captured in SRC-0008 ("WK-0153 capture: claude
 * and codex worker stdout shapes inside bwrap jail" — thread_id
 * `01a0e01c-d75f-7a01-ae3e-9882ba9495f6`, the `item_5` command_execution
 * item, the `turn.completed` usage line, and the claude result's
 * `num_turns: 6` / `duration_ms: 14591`, all quoted verbatim from that
 * capture). The pi case uses the real, pre-existing golden fixture
 * `tests/fixtures/pi-output-code-review.jsonl` unedited — SRC-0008's own
 * closing note calling pi a "single JSON blob" does not match this fixture
 * or `adapters/pi.ts`'s `parsePiOutput` (always JSON-lines); the real
 * fixture is the evidence that wins per DEC-0009.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkerEvents } from '../packages/dispatch-core/src/worker-events.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kb-dispatch-worker-events-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeWorkerOutput(content: string): Promise<string> {
  const path = join(tempDir, 'worker-output.log');
  await mkdir(tempDir, { recursive: true });
  await writeFile(path, content, 'utf-8');
  return path;
}

describe('parseWorkerEvents — WK-0153', () => {
  describe('codex JSONL (SRC-0008 capture)', () => {
    it('counts one turn, tallies item.completed events, and extracts a repo-relative touched path', async () => {
      const lines = [
        '{"type":"thread.started","thread_id":"01a0e01c-d75f-7a01-ae3e-9882ba9495f6"}',
        '{"type":"turn.started"}',
        '{"type":"item.started","item":{"id":"item_5","type":"command_execution","command":"/bin/bash -lc \'echo hi\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_5","type":"command_execution","command":"/bin/bash -lc \'echo hi\'","aggregated_output":"hi\\n","exit_code":0,"status":"completed"}}',
        '{"type":"item.started","item":{"id":"item_6","type":"file_change","changes":[{"path":"/home/mcap91/.kb-dispatch/clones/RUN-ed9b9c6e/src/file.txt","kind":"add"}],"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_6","type":"file_change","changes":[{"path":"/home/mcap91/.kb-dispatch/clones/RUN-ed9b9c6e/src/file.txt","kind":"add"}],"status":"completed"}}',
        '{"type":"item.completed","item":{"id":"item_8","type":"agent_message","text":"Created file.txt."}}',
        '{"type":"turn.completed","usage":{"input_tokens":153177,"output_tokens":2159}}',
      ];
      const path = await writeWorkerOutput(lines.join('\n') + '\n');

      const result = await parseWorkerEvents(path);

      expect(result.turnCount).toBe(1);
      expect(result.itemCount).toBe(3); // command_execution + file_change + agent_message item.completed events
      expect(result.filesTouched).toEqual(['src/file.txt']);
      expect(result.lastActivityAt).not.toBeNull();
      expect(() => new Date(result.lastActivityAt as string).toISOString()).not.toThrow();
    });
  });

  describe('claude single JSON object at exit (SRC-0008 capture)', () => {
    it('extracts num_turns and reports no items or files touched', async () => {
      const path = await writeWorkerOutput('{"type":"result","num_turns":6,"duration_ms":14591}\n');

      const result = await parseWorkerEvents(path);

      expect(result.turnCount).toBe(6);
      expect(result.filesTouched).toEqual([]);
      expect(result.itemCount).toBe(0);
      expect(result.lastActivityAt).not.toBeNull();
    });
  });

  describe('pi JSONL (real golden fixture, tests/fixtures/pi-output-code-review.jsonl)', () => {
    it('counts turn_start as the turn, and reports no items or files touched', async () => {
      const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'pi-output-code-review.jsonl');
      const fixtureContent = readFileSync(fixturePath, 'utf-8');
      const path = await writeWorkerOutput(fixtureContent);

      const result = await parseWorkerEvents(path);

      expect(result.turnCount).toBe(1); // one turn_start in the fixture
      expect(result.filesTouched).toEqual([]); // pi never emits file_change
      expect(result.itemCount).toBe(0); // item.completed is codex-only; pi's message_end doesn't count
      expect(result.lastActivityAt).not.toBeNull();
    });
  });

  describe('empty file', () => {
    it('returns the zero projection', async () => {
      const path = await writeWorkerOutput('');

      const result = await parseWorkerEvents(path);

      expect(result).toEqual({
        turnCount: 0,
        lastActivityAt: null,
        filesTouched: [],
        itemCount: 0,
      });
    });
  });

  describe('missing file', () => {
    it('returns the zero projection without throwing', async () => {
      const path = join(tempDir, 'does-not-exist.log');

      const result = await parseWorkerEvents(path);

      expect(result).toEqual({
        turnCount: 0,
        lastActivityAt: null,
        filesTouched: [],
        itemCount: 0,
      });
    });
  });

  describe('mixed valid and malformed lines', () => {
    it('counts valid JSONL events and silently skips garbage lines', async () => {
      const lines = [
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
        'not valid json {{{',
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":0,"status":"completed"}}',
        '{{{ garbage',
        '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":2}}',
      ];
      const path = await writeWorkerOutput(lines.join('\n') + '\n');

      const result = await parseWorkerEvents(path);

      expect(result.turnCount).toBe(2);
      expect(result.itemCount).toBe(1);
      expect(result.filesTouched).toEqual([]);
    });
  });
});
