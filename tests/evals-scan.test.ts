/**
 * WK-0237 slice A/B1a — scan.ts, the secret/personal-path scanner run
 * against jail captures before they are committed as fixtures (scope 15.1).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanContent, scanFixture } from '../evals/scan.js';

// This file compiles to CommonJS under NodeNext (no package.json "type": "module"),
// so `import.meta.url` is not usable; `__dirname` resolves fixture paths instead.
const EVALS_FIXTURES_DIR = join(__dirname, 'fixtures', 'evals');

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe('scanContent', () => {
  it('flags a /home/<user>/ path other than /home/eval', () => {
    const findings = scanContent('reading /home/alice/projects/kb/file.ts');
    expect(findings.some((f) => f.kind === 'personal-home-path')).toBe(true);
  });

  it('does not flag /home/eval paths', () => {
    const findings = scanContent('transcript at /home/eval/test_kb/.claude/commands/planner.md');
    expect(findings.some((f) => f.kind === 'personal-home-path')).toBe(false);
  });

  it('flags an email address', () => {
    const findings = scanContent('contact: alice@example.com');
    expect(findings.some((f) => f.kind === 'email')).toBe(true);
  });

  it('does not flag an @AGENTS.md-style import (WK-0237 scanner fix)', () => {
    const findings = scanContent('sessions.\n\n@AGENTS.md\nThis file is the compatibility entrypoint');
    expect(findings.some((f) => f.kind === 'email')).toBe(false);
  });

  it('still flags a real-shaped email planted in a JSONL line', () => {
    const line = JSON.stringify({ type: 'result', note: 'contact first.last@example.org' });
    const findings = scanContent(line);
    expect(findings.some((f) => f.kind === 'email')).toBe(true);
  });

  it('flags an sk-ant- key', () => {
    const findings = scanContent('key=sk-ant-abc123DEF456');
    expect(findings.some((f) => f.kind === 'anthropic-api-key')).toBe(true);
  });

  it('flags a Bearer header', () => {
    const findings = scanContent('Authorization: Bearer abc.def.ghi');
    expect(findings.some((f) => f.kind === 'bearer-header')).toBe(true);
  });

  it('flags an accessToken key', () => {
    const findings = scanContent('"accessToken": "xyz"');
    expect(findings.some((f) => f.kind === 'token-key')).toBe(true);
  });

  it('flags a refreshToken key', () => {
    const findings = scanContent('refreshToken=xyz');
    expect(findings.some((f) => f.kind === 'token-key')).toBe(true);
  });
});

describe('scanFixture', () => {
  it('passes a clean synthetic JSONL', () => {
    const clean =
      `${JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/eval/test_kb' })}\n` +
      JSON.stringify({ type: 'result', result: 'PASS' });

    const result = scanFixture(clean);
    expect(result.ok).toBe(true);
  });

  it('fails a fixture carrying a secret, naming the finding', () => {
    const dirty = JSON.stringify({ type: 'result', note: 'contact alice@example.com for help' });
    const result = scanFixture(dirty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('email');
  });

  it('fails a JSONL line carrying a planted real-shaped email', () => {
    const dirty = JSON.stringify({ type: 'result', note: 'reach me at first.last@example.org' });
    const result = scanFixture(dirty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('email');
  });
});

describe('committed evals fixtures', () => {
  it('every file under tests/fixtures/evals/ passes scanFixture', () => {
    for (const file of listFilesRecursive(EVALS_FIXTURES_DIR)) {
      const content = readFileSync(file, 'utf8');
      const result = scanFixture(content);
      expect(result.ok, `${file}: ${result.ok ? '' : result.message}`).toBe(true);
    }
  });
});
