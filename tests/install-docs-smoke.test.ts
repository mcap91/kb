/**
 * WK-0261 AC 7: the install pages are executable. Each page marks its command block with
 * `<!-- install-smoke: <name> -->` on the line before a ```bash fence. This test runs each
 * block verbatim with bash from the kb checkout, `MY_REPO` set to a fresh fixture, and
 * checks the layer the page promises. A page whose commands drift fails here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createTmpDir, readJson, type TmpRepo } from './helpers/tmp-repo.js';

const KB_ROOT = path.resolve(__dirname, '..');
const SMOKE_TIMEOUT = 60_000;

/** Return the bash block marked `<!-- install-smoke: <name> -->` in a docs page. */
function smokeBlock(page: string, name: string): string {
  const text = fs.readFileSync(path.join(KB_ROOT, 'docs', page), 'utf-8').replace(/\r\n/g, '\n');
  const marker = `<!-- install-smoke: ${name} -->\n\`\`\`bash\n`;
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`docs/${page} has no install-smoke block "${name}"`);
  const body = text.slice(start + marker.length);
  return body.slice(0, body.indexOf('```'));
}

function runBlock(page: string, name: string, repoDir: string): string {
  return execFileSync('bash', ['-euo', 'pipefail', '-c', smokeBlock(page, name)], {
    cwd: KB_ROOT,
    env: { ...process.env, MY_REPO: repoDir },
    encoding: 'utf-8',
    timeout: SMOKE_TIMEOUT,
  });
}

function templates(dir: string): string[] {
  return fs.readdirSync(path.join(dir, 'wiki', 'templates')).sort();
}

function mcpServers(dir: string): string[] {
  return Object.keys(readJson<{ mcpServers: Record<string, unknown> }>(dir, '.mcp.json').mcpServers).sort();
}

const WIKI_TEMPLATES = ['area.md', 'decision.md', 'initiative.md', 'issue.md', 'source.md'];

describe('install pages run verbatim (WK-0261 AC 7)', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('adoption.md (Codex): bootstrap prints the codex mcp add command and writes no .mcp.json', () => {
    tmp = createTmpDir();
    const out = runBlock('adoption.md', 'wiki-codex', tmp.dir);
    expect(out).toContain('codex mcp add kb-wiki -- node');
    expect(fs.existsSync(path.join(tmp.dir, '.mcp.json'))).toBe(false);
    expect(templates(tmp.dir)).toEqual(WIKI_TEMPLATES);
  }, SMOKE_TIMEOUT);

  it('adoption.md (Claude) then install-planning.md install and remove', () => {
    tmp = createTmpDir();
    runBlock('adoption.md', 'wiki', tmp.dir);
    expect(templates(tmp.dir)).toEqual(WIKI_TEMPLATES);
    expect(mcpServers(tmp.dir)).toEqual(['kb-wiki']);

    runBlock('install-planning.md', 'planning', tmp.dir);
    expect(templates(tmp.dir)).toEqual([...WIKI_TEMPLATES, 'escalation.md'].sort());
    expect(fs.existsSync(path.join(tmp.dir, '.agents/skills/resolve/SKILL.md'))).toBe(true);

    const out = runBlock('install-planning.md', 'planning-remove', tmp.dir);
    expect(out).toContain('- removed: wiki/templates/escalation.md');
    expect(templates(tmp.dir)).toEqual(WIKI_TEMPLATES);
  }, SMOKE_TIMEOUT * 2);

  it('adoption.md (Claude) then install-dispatch.md', () => {
    tmp = createTmpDir();
    runBlock('adoption.md', 'wiki', tmp.dir);
    runBlock('install-dispatch.md', 'dispatch', tmp.dir);
    expect(templates(tmp.dir)).toEqual([...WIKI_TEMPLATES, 'escalation.md', 'handoff.md'].sort());
    expect(fs.existsSync(path.join(tmp.dir, 'wiki/handoffs'))).toBe(true);
    expect(mcpServers(tmp.dir)).toEqual(['kb-dispatch', 'kb-wiki']);
  }, SMOKE_TIMEOUT * 2);
});
