/**
 * Value-list secret scrubber — unit tests for secret-scrub.ts plus real
 * process tests for its wiring through spawn-isolated.ts.
 *
 * The unit half is pure: build the list, expand the five match forms, and
 * assert the streaming matcher catches every form, a value split across two
 * pushes at every byte offset, newline-bearing values, overlapping values,
 * and the held-byte bound. The process half runs a REAL child process against
 * a fake `bwrap` executable first on PATH (the dispatch-v2-spawn.test.ts
 * pattern — no `vi.mock`, so the scrubber is exercised against real pipe
 * chunking and stream-close ordering), and proves the redaction reaches the
 * in-memory capture, the on-disk log, and readLogTail, that a timeout-killed
 * run still flushes its tail, and that the same run WITHOUT `secretValues`
 * exposes the plaintext (so the check bites).
 *
 * No personal/absolute paths appear in fixtures; all
 * filesystem tests use temp dirs. The planted values are obvious placeholder
 * strings, never real-looking live tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSecretValueList,
  createSecretMatcher,
  createSecretScrubber,
  loadKnownSecretValues,
  readCredentialLine,
  scrubFileInPlace,
  scrubText,
  scrubValue,
  type SecretValue,
} from '../packages/dispatch-core/src/secret-scrub.js';
import { spawnIsolated } from '../packages/dispatch-core/src/spawn-isolated.js';
import { buildBwrapPlan, type BwrapPlan } from '../packages/dispatch-core/src/jail.js';
import { readLogTail } from '../packages/dispatch-core/src/status.js';

/** Build a list directly, failing loudly on a build error (test fixture only). */
function makeList(...pairs: Array<[string, string]>): SecretValue[] {
  const result = buildSecretValueList({ values: pairs.map(([name, value]) => ({ name, value })) });
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

/** The five match forms of a value, independently derived (mirrors the module's contract, not its code). */
function formsOf(value: string): string[] {
  const once = JSON.stringify(value).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [
    ...new Set([
      value,
      once,
      twice,
      encodeURIComponent(value),
      Buffer.from(value, 'utf8').toString('base64'),
    ]),
  ];
}

function longestFormBytes(value: string): number {
  return Math.max(...formsOf(value).map((form) => Buffer.byteLength(form, 'utf8')));
}

// ---------------------------------------------------------------------------
// Unit: buildSecretValueList
// ---------------------------------------------------------------------------

describe('buildSecretValueList', () => {
  it('keeps 16-character values and drops 15-character ones', () => {
    const result = buildSecretValueList({
      values: [
        { name: 'EDGE_OK', value: 'a'.repeat(16) },
        { name: 'TOO_SHORT', value: 'a'.repeat(15) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([{ name: 'EDGE_OK', value: 'a'.repeat(16) }]);
  });

  it('names nested-object and array leaves <label>:<path>', () => {
    const result = buildSecretValueList({
      values: [],
      snapshots: [
        { label: 'x', bytes: JSON.stringify({ a: { b: 'B'.repeat(20) } }) },
        { label: 'x', bytes: JSON.stringify({ a: [{ b: 'C'.repeat(20) }] }) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { name: 'x:a.b', value: 'B'.repeat(20) },
      { name: 'x:a[0].b', value: 'C'.repeat(20) },
    ]);
  });

  it('drops string leaves shorter than 16 characters', () => {
    const result = buildSecretValueList({
      values: [],
      snapshots: [{ label: 'x', bytes: JSON.stringify({ a: { b: 'short' } }) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it('fails a malformed snapshot naming the label only, never the bytes', () => {
    const planted = 'MALFORMED-PLANTED-VALUE-0123456789';
    const result = buildSecretValueList({
      values: [],
      snapshots: [{ label: 'broken-snapshot', bytes: `not json ${planted}` }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('broken-snapshot');
    expect(result.message).not.toContain(planted);
  });
});

// ---------------------------------------------------------------------------
// Unit: matcher forms and edges
// ---------------------------------------------------------------------------

describe('createSecretScrubber / scrubText', () => {
  it('replaces each of the five forms of a planted 40-character value', () => {
    const value = 'S3cr3t-Value-0123456789-abcdefghij-' + 'X'.repeat(5);
    expect(value.length).toBe(40);
    const list = makeList(['TOKEN', value]);
    for (const form of formsOf(value)) {
      const out = scrubText(`before ${form} after`, list);
      expect(out).toContain('[REDACTED:TOKEN]');
      expect(out).not.toContain(form);
      expect(out.startsWith('before ')).toBe(true);
      expect(out.endsWith(' after')).toBe(true);
    }
  });

  it('catches a value split across two pushes at every byte offset', () => {
    const value = 'split-boundary-value-0123456789-abcdef';
    const list = makeList(['SPLIT', value]);
    const bytes = Buffer.from(value, 'utf8');
    for (let offset = 0; offset <= bytes.length; offset += 1) {
      const scrubber = createSecretScrubber(list);
      const out = Buffer.concat([
        scrubber.push(bytes.subarray(0, offset)),
        scrubber.push(bytes.subarray(offset)),
        scrubber.flush(),
      ]);
      expect(out.toString('utf8')).toBe('[REDACTED:SPLIT]');
    }
  });

  it('catches a value containing a newline, including when split at the newline', () => {
    const value = 'line-one\nline-two-0123456789';
    const list = makeList(['NL', value]);
    expect(scrubText(`a\n${value}\nb`, list)).toBe('a\n[REDACTED:NL]\nb');

    const newlineIdx = Buffer.byteLength('line-one', 'utf8');
    const bytes = Buffer.from(value, 'utf8');
    const scrubber = createSecretScrubber(list);
    const out = Buffer.concat([
      scrubber.push(bytes.subarray(0, newlineIdx)),
      scrubber.push(bytes.subarray(newlineIdx)),
      scrubber.flush(),
    ]);
    expect(out.toString('utf8')).toBe('[REDACTED:NL]');
  });

  it('holds back under twice the longest form on a 200 KiB push with no newline', () => {
    const value = 'x'.repeat(40);
    const list = makeList(['BIG', value]);
    const longest = longestFormBytes(value);
    const scrubber = createSecretScrubber(list);
    const chunk = Buffer.alloc(200 * 1024, 0x61); // 'a' bytes, no newline

    const emitted = scrubber.push(chunk);
    const held = scrubber.heldBytes();
    expect(emitted.length + held).toBe(chunk.length);
    expect(emitted.equals(chunk.subarray(0, chunk.length - held))).toBe(true);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(2 * longest);

    // The held bytes are the chunk's own filler tail, returned unchanged.
    const flushed = scrubber.flush();
    expect(scrubber.heldBytes()).toBe(0);
    expect(flushed.length).toBe(held);
    expect(flushed.toString('utf8')).toBe('a'.repeat(held));
  });

  it('leaves no plaintext byte of either of two overlapping values (cut walks back to the earliest start)', () => {
    // Layout: filler(60) + X20 + W20 + Y20 + tail(45), with vA=X20W20,
    // vB=W20Y20, vC=Y20. vA is [60,100), vB is [80,120), vC is [100,120):
    // vB and vC both overlap the region and cross the initial cut at byte
    // 110 (longest form base64=56 bytes). A single-move cut would stop at 80
    // and leak vA's first 20 bytes; the fixpoint walks back to 60, holds
    // everything, and leaks neither value's bytes.
    const x = 'X'.repeat(20);
    const w = 'W'.repeat(20);
    const y = 'Y'.repeat(20);
    const vA = x + w;
    const vB = w + y;
    const vC = y;
    const filler = 'f'.repeat(60);
    const tail = 't'.repeat(45);
    const buffer = filler + x + w + y + tail;
    const list = makeList(['A', vA], ['B', vB], ['C', vC]);

    const scrubber = createSecretScrubber(list);
    const emitted = scrubber.push(Buffer.from(buffer, 'utf8'));
    expect(emitted.toString('utf8')).toBe(filler);
    expect(scrubber.heldBytes()).toBe(x.length + w.length + y.length + tail.length);

    const flushed = scrubber.flush().toString('utf8');
    expect(flushed).toContain('[REDACTED:A]');
    expect(flushed).toContain('[REDACTED:C]');
    const all = emitted.toString('utf8') + flushed;
    for (const value of [vA, vB, vC]) expect(all).not.toContain(value);
  });

  it('prefers the longer value when one is a prefix of the other at the same start', () => {
    const short = 'P'.repeat(30);
    const long = 'P'.repeat(40);
    const list = makeList(['SHORT', short], ['LONG', long]);
    expect(scrubText(`${short}Z${long}`, list)).toBe('[REDACTED:SHORT]Z[REDACTED:LONG]');

    const list2 = makeList(['LONG', long], ['SHORT', short]);
    expect(scrubText(long, list2)).toBe('[REDACTED:LONG]');
  });

  it('writes a quote or backslash in the value name as an underscore', () => {
    const value = 'name-sanitize-value-0123456789';
    const list = makeList(['BAD"NAME\\X', value]);
    const out = scrubText(value, list);
    expect(out).toBe('[REDACTED:BAD_NAME_X]');
    expect(out).not.toContain('"');
    expect(out).not.toContain('\\');
  });

  it('flush returns the remainder, and a second flush is empty', () => {
    const value = 'flush-remainder-value-0123456789';
    const list = makeList(['R', value]);
    const scrubber = createSecretScrubber(list);
    expect(scrubber.push(Buffer.from(value, 'utf8')).length).toBe(0);
    expect(scrubber.flush().toString('utf8')).toBe('[REDACTED:R]');
    expect(scrubber.heldBytes()).toBe(0);
    expect(scrubber.flush().length).toBe(0);
  });

  it('passes bytes through unchanged with an empty list', () => {
    const scrubber = createSecretScrubber([]);
    const chunk = Buffer.from('hello world');
    expect(scrubber.push(chunk)).toBe(chunk);
    expect(scrubber.heldBytes()).toBe(0);
    expect(scrubber.flush().length).toBe(0);
    expect(scrubText('a 15-char value is short', makeList(['SHORT', 'a'.repeat(15)]))).toBe(
      'a 15-char value is short',
    );
  });
});

// ---------------------------------------------------------------------------
// Unit: createSecretMatcher
// ---------------------------------------------------------------------------

describe('createSecretMatcher', () => {
  // 40 characters, and every one of the five forms is distinct: the raw value
  // carries `"`, `\`, a space and `&`, so JSON escaping, double JSON escaping,
  // percent-encoding and base64 each change it.
  const value = 'a"b\\c d&e' + 'X'.repeat(31);

  it('finds the value in each of the five encodings of the same 40-char value', () => {
    expect(value.length).toBe(40);
    expect(formsOf(value).length).toBe(5);
    const list = makeList(['TOKEN', value]);
    for (const form of formsOf(value)) {
      const matcher = createSecretMatcher(list);
      matcher.push(Buffer.from(`prefix ${form} suffix`, 'utf8'));
      expect(matcher.names()).toEqual(['TOKEN']);
    }
  });

  it('finds a value split across two pushes at every byte offset', () => {
    const list = makeList(['SPLIT', value]);
    const bytes = Buffer.from(`00 ${value} 11`, 'utf8');
    for (let offset = 0; offset <= bytes.length; offset += 1) {
      const matcher = createSecretMatcher(list);
      matcher.push(bytes.subarray(0, offset));
      matcher.push(bytes.subarray(offset));
      expect(matcher.names(), `offset ${offset}`).toEqual(['SPLIT']);
    }
  });

  it('returns both names once, in list order, when two values are found', () => {
    const first = 'first-planted-value-0123456789';
    const second = 'second-planted-value-9876543210';
    const matcher = createSecretMatcher(makeList(['ONE', first], ['TWO', second]));
    // `second` appears first in the buffer; `names()` still reports list order.
    matcher.push(Buffer.from(`x ${second} y ${first} z`, 'utf8'));
    expect(matcher.names()).toEqual(['ONE', 'TWO']);
  });

  it('no-ops and returns [] for an empty list or a list that gives no form', () => {
    const empty = createSecretMatcher([]);
    const chunk = Buffer.from('anything at all');
    empty.push(chunk);
    expect(empty.names()).toEqual([]);

    const tooShort = createSecretMatcher(makeList(['SHORT', 'a'.repeat(15)]));
    tooShort.push(Buffer.from('a'.repeat(15)));
    expect(tooShort.names()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit: scrubValue
// ---------------------------------------------------------------------------

describe('scrubValue', () => {
  it('replaces a planted value in a nested object, in an array, and in an Error message', () => {
    const value = 'scrub-value-planted-0123456789-abcdef';
    const list = makeList(['PLANT', value]);
    const input = {
      outer: { inner: `a ${value} b` },
      arr: [`c ${value} d`, 7],
      err: new Error(`failed with ${value}`),
    };
    const out = scrubValue(input, list);
    expect(out.outer.inner).toBe('a [REDACTED:PLANT] b');
    expect(out.arr[0]).toBe('c [REDACTED:PLANT] d');
    expect(out.arr[1]).toBe(7);
    const err = out.err as unknown as { name: string; message: string };
    expect(err.message).toBe('failed with [REDACTED:PLANT]');
    expect(out.err).not.toBeInstanceOf(Error);
  });

  it('leaves numbers, booleans and null unchanged', () => {
    const list = makeList(['PLANT', 'scrub-value-planted-0123456789-abcdef']);
    const input = { n: 3, f: 1.5, t: true, f2: false, z: null, u: undefined };
    expect(scrubValue(input, list)).toEqual(input);
  });

  it('leaves its input unchanged', () => {
    const value = 'scrub-value-planted-0123456789-abcdef';
    const list = makeList(['PLANT', value]);
    const input = { s: value, nested: { s: value }, arr: [value], err: new Error(value) };
    const out = scrubValue(input, list);
    expect(input.s).toBe(value);
    expect(input.nested.s).toBe(value);
    expect(input.arr[0]).toBe(value);
    expect(input.err.message).toBe(value);
    expect(JSON.stringify(out)).not.toContain(value);
  });
});

// ---------------------------------------------------------------------------
// Unit: scrubFileInPlace
// ---------------------------------------------------------------------------

describe('scrubFileInPlace', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'secret-scrub-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces the value in a file and returns true', async () => {
    const value = 'file-planted-value-0123456789-abcdef';
    const path = join(dir, 'log.txt');
    await writeFile(path, `before ${value} after\n`, 'utf8');
    const result = await scrubFileInPlace(path, makeList(['FILE', value]));
    expect(result).toEqual({ ok: true, data: true });
    expect(await readFile(path, 'utf8')).toBe('before [REDACTED:FILE] after\n');
  });

  it('leaves a clean file unwritten, with the same mtime, and returns false', async () => {
    const path = join(dir, 'clean.txt');
    await writeFile(path, 'nothing to scrub here\n', 'utf8');
    const before = await stat(path);
    const result = await scrubFileInPlace(path, makeList(['FILE', 'file-planted-value-0123456789-abcdef']));
    expect(result).toEqual({ ok: true, data: false });
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('returns ok(false) for a missing file', async () => {
    const result = await scrubFileInPlace(
      join(dir, 'missing.txt'),
      makeList(['FILE', 'file-planted-value-0123456789-abcdef']),
    );
    expect(result).toEqual({ ok: true, data: false });
  });

  it('leaves no temp file in the directory', async () => {
    const value = 'file-planted-value-0123456789-abcdef';
    const path = join(dir, 'a.txt');
    await writeFile(path, value, 'utf8');
    await scrubFileInPlace(path, makeList(['FILE', value]));
    expect(await readdir(dir)).toEqual(['a.txt']);
  });
});

// ---------------------------------------------------------------------------
// Unit: readCredentialLine
// ---------------------------------------------------------------------------

describe('readCredentialLine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'secret-scrub-cred-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the value after the NAME= line', async () => {
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'OTHER=x\nHF_TOKEN=the-value\n', 'utf8');
    expect(await readCredentialLine('HF_TOKEN', path)).toEqual({ ok: true, data: 'the-value' });
  });

  it("gives today's missing-from-source-file message when the line is absent", async () => {
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'OTHER=x\n', 'utf8');
    expect(await readCredentialLine('HF_TOKEN', path)).toEqual({
      ok: false,
      error: 'CREDENTIAL_NOT_CONFIGURED',
      message: 'Credential variable "HF_TOKEN" is not configured (missing from its named source file).',
    });
  });

  it("gives today's could-not-read message when the file cannot be read", async () => {
    const path = join(dir, 'absent.env');
    const result = await readCredentialLine('HF_TOKEN', path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('CREDENTIAL_NOT_CONFIGURED');
    expect(result.message.startsWith(`Credential variable "HF_TOKEN" is not configured (could not read ${path}: `)).toBe(true);
    expect(result.message.endsWith(').')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: loadKnownSecretValues
// ---------------------------------------------------------------------------

describe('loadKnownSecretValues', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'secret-scrub-load-'));
    await mkdir(join(dir, 'wiki', '.dispatch'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSecrets(name: string, varName: string, value: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `${varName}=${value}\n`, 'utf8');
    return path;
  }

  it('holds a planted profile value and a planted backend key, by name', async () => {
    const profileValue = 'profile-planted-value-0123456789-abcde';
    const backendValue = 'backend-planted-key-0123456789-abcdefg';
    const profileFile = await writeSecrets('profile.env', 'HF_TOKEN', profileValue);
    const backendFile = await writeSecrets('backend.env', 'OPENROUTER_API_KEY', backendValue);
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'profiles.json'),
      JSON.stringify({ schema_version: 1, hf: { inject: { HF_TOKEN: profileFile } } }),
      'utf8',
    );
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'backends.json'),
      JSON.stringify({ openrouter: { family: 'pi', base_url: null, api_key_env: 'OPENROUTER_API_KEY', secrets_file: backendFile } }),
      'utf8',
    );

    const result = await loadKnownSecretValues(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { name: 'HF_TOKEN', value: profileValue },
      { name: 'OPENROUTER_API_KEY', value: backendValue },
    ]);
  });

  it('skips an unreadable file and writes the stderr line, which names the file and holds no value', async () => {
    const missingFile = join(dir, 'missing.env');
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'profiles.json'),
      JSON.stringify({ schema_version: 1, hf: { inject: { LOST_TOKEN: missingFile } } }),
      'utf8',
    );

    const chunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const result = await loadKnownSecretValues(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
      const text = chunks.join('');
      expect(text).toContain(`[secret-scrub] warning: skipped LOST_TOKEN from ${missingFile}: CREDENTIAL_NOT_CONFIGURED`);
      expect(text).not.toContain('=');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns BAD_RECORD for an invalid profiles.json', async () => {
    await writeFile(
      join(dir, 'wiki', '.dispatch', 'profiles.json'),
      JSON.stringify({ schema_version: 2 }),
      'utf8',
    );
    const result = await loadKnownSecretValues(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('BAD_RECORD');
  });
});

// ---------------------------------------------------------------------------
// Process: spawnIsolated wiring (real child process, fake bwrap)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('spawnIsolated secret scrubbing (real child, fake bwrap)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'secret-scrub-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function installFakeBwrap(scriptBody: string): Promise<void> {
    const bwrapPath = join(workDir, 'bwrap');
    await writeFile(bwrapPath, scriptBody, 'utf8');
    await chmod(bwrapPath, 0o755);
  }

  function planWithFakeBwrap(injectedFiles?: ReadonlyArray<{ content: string; dest: string }>): BwrapPlan {
    return buildBwrapPlan({
      clonePath: '/tmp/test-clone',
      command: ['worker'],
      env: { PATH: `${workDir}:/usr/bin:/bin` },
      injectedFiles,
    });
  }

  /** A fake bwrap that prints every form once to stdout and once to stderr, then exits 0. */
  function formsScript(forms: readonly string[]): string {
    const out = forms.join('\n') + '\n';
    return `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(out)});\nprocess.stderr.write(${JSON.stringify(out)});\n`;
  }

  it('redacts every form in the in-memory capture, the on-disk log, and readLogTail', async () => {
    const value = 'pr0c/\n+"tokén-0123456789';
    const forms = formsOf(value);
    expect(forms.length).toBe(5);
    await installFakeBwrap(formsScript(forms));

    const runDir = join(workDir, 'run');
    await mkdir(runDir, { recursive: true });
    const logPath = join(runDir, 'worker-output.log');
    const result = await spawnIsolated(planWithFakeBwrap(), {
      timeoutMs: 5000,
      stdoutLogPath: logPath,
      secretValues: makeList(['PROC_TOKEN', value]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('[REDACTED:PROC_TOKEN]');
    expect(result.data.stdout).toContain('[REDACTED:PROC_TOKEN]');
    expect(result.data.stderr).toContain('[REDACTED:PROC_TOKEN]');
    for (const form of forms) {
      expect(log).not.toContain(form);
      expect(result.data.stdout).not.toContain(form);
      expect(result.data.stderr).not.toContain(form);
    }

    const tail = await readLogTail(runDir, 20);
    expect(tail).not.toBeNull();
    const tailText = (tail ?? []).join('\n');
    expect(tailText).toContain('[REDACTED:PROC_TOKEN]');
    for (const form of forms) expect(tailText).not.toContain(form);
  });

  it('flushes and redacts the last line of a run killed by the timeout clock', async () => {
    const value = 'timeout-token-abcdefghij-0123456789';
    const script = `#!${process.execPath}\nprocess.stdout.write('BEFORE\\n' + ${JSON.stringify(value)} + '\\n');\nsetInterval(() => {}, 1000);\n`;
    await installFakeBwrap(script);

    const runDir = join(workDir, 'run-timeout');
    await mkdir(runDir, { recursive: true });
    const logPath = join(runDir, 'worker-output.log');
    const result = await spawnIsolated(planWithFakeBwrap(), {
      timeoutMs: 300,
      stdoutLogPath: logPath,
      secretValues: makeList(['TIMEOUT_TOKEN', value]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.timedOut).toBe(true);

    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('BEFORE');
    expect(log).toContain('[REDACTED:TIMEOUT_TOKEN]');
    expect(log).not.toContain(value);
  });

  it('without secretValues the same run exposes the plaintext (the check bites)', async () => {
    const value = 'control-token-abcdefghij-0123456789';
    const forms = formsOf(value);
    await installFakeBwrap(formsScript(forms));

    const runDir = join(workDir, 'run-control');
    await mkdir(runDir, { recursive: true });
    const logPath = join(runDir, 'worker-output.log');
    const result = await spawnIsolated(planWithFakeBwrap(), { timeoutMs: 5000, stdoutLogPath: logPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain(value);
    expect(log).not.toContain('[REDACTED:CONTROL_TOKEN]');
    expect(result.data.stdout).toContain(value);
  });
});
