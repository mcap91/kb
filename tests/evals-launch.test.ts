/**
 * WK-0237 slice A — launch.ts, driven with `node -e` commands (never a real
 * claude/bwrap call, per constraint). Covers a normal exit, a timeout kill,
 * stdin wired to /dev/null, and stdout/stderr landing in the right capture
 * files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch } from '../evals/launch.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-eval-launch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('launch', () => {
  it('records exit code 0 and wall time for a normal exit, capturing stdout to stream.jsonl', async () => {
    const result = await launch({
      command: ['node', '-e', 'process.stdout.write("hello\\n");'],
      captureDir: dir,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.exitCode).toBe(0);
    expect(result.data.signal).toBeNull();
    expect(result.data.timedOut).toBe(false);
    expect(result.data.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(dir, 'stream.jsonl'), 'utf8')).toBe('hello\n');

    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.exitCode).toBe(0);
    expect(runJson.timedOut).toBe(false);
  });

  it('kills a command that outlives a 1-second timeout, recording timedOut: true in run.json', async () => {
    const result = await launch({
      command: ['node', '-e', 'setInterval(() => {}, 1000);'],
      captureDir: dir,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.timedOut).toBe(true);

    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.timedOut).toBe(true);
  }, 10_000);

  it('wires stdin to /dev/null — a child reading stdin sees immediate EOF', async () => {
    const result = await launch({
      command: [
        'node',
        '-e',
        'process.stdin.on("data", () => {}); process.stdin.on("end", () => { process.stdout.write("STDIN_EOF\\n"); });',
      ],
      captureDir: dir,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'stream.jsonl'), 'utf8')).toContain('STDIN_EOF');
  });

  it('writes stderr to stderr.log, separate from stdout', async () => {
    const result = await launch({
      command: ['node', '-e', 'process.stderr.write("oops\\n"); process.exitCode = 1;'],
      captureDir: dir,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.exitCode).toBe(1);
    expect(readFileSync(join(dir, 'stderr.log'), 'utf8')).toBe('oops\n');
    expect(readFileSync(join(dir, 'stream.jsonl'), 'utf8')).toBe('');
  });

  it('merges extra metadata into run.json alongside the launch result', async () => {
    const result = await launch({
      command: ['node', '-e', ''],
      captureDir: dir,
      timeoutMs: 5000,
      metadata: { baselineSha: 'deadbeef', cliVersion: '2.1.281' },
    });

    expect(result.ok).toBe(true);
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.baselineSha).toBe('deadbeef');
    expect(runJson.cliVersion).toBe('2.1.281');
  });
});
