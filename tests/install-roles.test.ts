import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const ROOT = resolve(process.cwd());
const TSX = process.platform === 'win32'
  ? resolve(ROOT, 'node_modules/.bin/tsx.cmd')
  : resolve(ROOT, 'node_modules/.bin/tsx');
const CLI = resolve(ROOT, 'packages/wiki-cli/src/index.ts');
const ROLES_DIR = resolve(ROOT, 'contract/roles');

const tempHomes: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'kb-install-roles-'));
  tempHomes.push(dir);
  return dir;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('install-roles', () => {
  it('stamps every contract/roles/*.md file byte-identical into an isolated HOME, and the installed planner carries the smoke-test sentence', () => {
    const home = makeTempHome();

    const stdout = execSync(`"${TSX}" "${CLI}" install-roles --dir "${ROOT}"`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(stdout).toContain('Installing');

    const roleFiles = fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md'));
    expect(roleFiles.length).toBeGreaterThan(0);

    const destDirs = [join(home, '.claude', 'commands'), join(home, '.codex', 'prompts')];
    for (const destDir of destDirs) {
      for (const filename of roleFiles) {
        const sourceContent = fs.readFileSync(join(ROLES_DIR, filename), 'utf8');
        const installedContent = fs.readFileSync(join(destDir, filename), 'utf8');
        expect(installedContent).toBe(sourceContent);
      }
    }

    const installedPlanner = fs.readFileSync(join(destDirs[0]!, 'planner.md'), 'utf8');
    expect(installedPlanner).toContain(
      'Specs for pipeline work include as an acceptance criterion: a quick e2e smoke run on small real fixtures passes; if none exists, the spec includes creating one.'
    );
  });
});
