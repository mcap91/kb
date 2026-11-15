/**
 * Mechanical drift-check gate: no stale `.js` or extensionless
 * reference to the tunnel forwarder/relay script names survives in the
 * tracked working tree. `forwarder.cjs`/`relay.cjs` (tunnel.ts's
 * `TUNNEL_FORWARDER_SCRIPT_NAME`/`TUNNEL_RELAY_SCRIPT_NAME`) pin CommonJS
 * regardless of a target repo's own `package.json` `"type"` field; a
 * leftover `forwarder.js`/`relay.js` reference anywhere else in the tracked
 * tree would point at a file dispatch no longer writes, and an extensionless
 * specifier (`require('./forwarder')` style) would never resolve a `.cjs`
 * file at all (Node's bare-specifier resolution only tries `.js`/`.json`/
 * `.node`/index files, never `.cjs`).
 *
 * Boundary: tracked files only, via `git ls-files` —
 * untracked scratch/build output is irrelevant. Exempt paths legitimately
 * carry the OLD names: `.agent-runs/` and `scratch_space/` are runtime/
 * planning artifacts (never canonical, per AGENTS.md); `wiki/` is a
 * SEPARATE nested repository with historical captures; `tests/fixtures/
 * RUN-<id>/` directories are captured run bundles from before this fix
 * (real, unedited captures — rule 33); this file itself is exempt by its
 * own path, since its doc comment, describe title, and bite-proof sample
 * strings necessarily contain the literal stale names it searches for.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = join(__dirname, '..');

const OWN_REL_PATH = relative(REPO_ROOT, __filename).split(sep).join('/');

const EXEMPT_PREFIXES = ['wiki/', 'scratch_space/', '.agent-runs/'];

function isExempt(relPath: string): boolean {
  if (relPath === OWN_REL_PATH) return true;
  if (EXEMPT_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  if (/^tests\/fixtures\/RUN-[^/]+\//.test(relPath)) return true;
  return false;
}

// Matches a literal "forwarder.js"/"relay.js" reference, whether as plain
// text or inside a JS/TS regex literal's source text (e.g. `\.js` already
// reads as literal ".js" to this checker either way).
const STALE_JS_PATTERN = /\b(forwarder|relay)\.js\b/;

// A quoted bare specifier naming the script with no extension at all —
// never resolves a `.cjs` file via Node's own bare-specifier resolution.
const EXTENSIONLESS_SPECIFIER_PATTERN = /['"`](?:\.{1,2}\/)*(forwarder|relay)['"`]/;

describe('no stale forwarder.js/relay.js reference in the tracked tree', () => {
  it('git ls-files contains no stale .js or extensionless reference to the tunnel script names outside exempt paths', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((relPath) => relPath.length > 0)
      .filter((relPath) => !isExempt(relPath));

    const offenders: string[] = [];
    for (const relPath of tracked) {
      let content: string;
      try {
        content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      } catch {
        continue; // binary/unreadable file -- never a text reference to a script name
      }
      if (STALE_JS_PATTERN.test(content) || EXTENSIONLESS_SPECIFIER_PATTERN.test(content)) {
        offenders.push(relPath);
      }
    }

    expect(
      offenders,
      `stale forwarder.js/relay.js (or extensionless) reference found in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('bite proof: the stale-.js pattern actually catches the pre-fix shape and lets the .cjs shape through', () => {
    expect(STALE_JS_PATTERN.test("console.error('usage: node forwarder.js <socketPath>')")).toBe(true);
    expect(STALE_JS_PATTERN.test("console.error('usage: node forwarder.cjs <socketPath>')")).toBe(false);
    expect(STALE_JS_PATTERN.test("const relayScriptPath = `${runDirWsl}/relay.js`;")).toBe(true);
    expect(STALE_JS_PATTERN.test("const relayScriptPath = `${runDirWsl}/relay.cjs`;")).toBe(false);
  });

  it('bite proof: the extensionless-specifier pattern catches a bare require()-style reference', () => {
    expect(EXTENSIONLESS_SPECIFIER_PATTERN.test("require('./forwarder')")).toBe(true);
    expect(EXTENSIONLESS_SPECIFIER_PATTERN.test("require('./forwarder.cjs')")).toBe(false);
  });
});
