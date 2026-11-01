/**
 * Secret/personal-path scanner for jail captures before they are committed
 * as fixtures (WK-0237 scope 15.1, "Secret-safe intake" in
 * docs/verify-dispatch.md). A capture that fails this scan is re-captured,
 * never scrubbed in place (DEC-0009).
 */
import { fail, ok, type EvalResult } from './result.js';

export interface ScanFinding {
  kind: string;
  match: string;
  line: number;
}

const HOME_PATH_RE = /\/home\/([^/\s"'\\]+)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer\s+\S+/g;
const TOKEN_KEY_RE = /\b(accessToken|refreshToken)\b["']?\s*[:=]/g;

/** Scans raw fixture text and returns every finding (personal `/home/<user>/` paths other than `/home/eval/`, emails, `sk-ant-` keys, `Bearer` headers, `accessToken`/`refreshToken` keys). Empty array means clean. */
export function scanContent(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    for (const match of line.matchAll(HOME_PATH_RE)) {
      const user = match[1];
      if (user !== undefined && user !== 'eval') {
        findings.push({ kind: 'personal-home-path', match: match[0], line: idx + 1 });
      }
    }
    for (const match of line.matchAll(EMAIL_RE)) {
      findings.push({ kind: 'email', match: match[0], line: idx + 1 });
    }
    for (const match of line.matchAll(ANTHROPIC_KEY_RE)) {
      findings.push({ kind: 'anthropic-api-key', match: match[0], line: idx + 1 });
    }
    for (const match of line.matchAll(BEARER_RE)) {
      findings.push({ kind: 'bearer-header', match: match[0], line: idx + 1 });
    }
    for (const match of line.matchAll(TOKEN_KEY_RE)) {
      findings.push({ kind: 'token-key', match: match[0], line: idx + 1 });
    }
  });

  return findings;
}

/** `ok` when `scanContent` finds nothing; `fail` naming every finding otherwise. */
export function scanFixture(content: string): EvalResult<void> {
  const findings = scanContent(content);
  if (findings.length === 0) return ok(undefined);
  const summary = findings.map((f) => `${f.kind} at line ${f.line}: ${f.match}`).join('; ');
  return fail('SECRET_OR_PERSONAL_PATH_FOUND', summary);
}
