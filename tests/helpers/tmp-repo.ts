/**
 * Test helper: creates a temporary directory with a minimal wiki structure.
 *
 * Runs bootstrap programmatically to set up the directory structure,
 * or allows manual setup for specific test scenarios.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap, initPlanning, sync } from '../../packages/wiki-core/src/index.js';

export interface TmpRepo {
  /** Absolute path to the temporary directory. */
  dir: string;
  /** Clean up the temporary directory. */
  cleanup: () => void;
}

/**
 * Create a temporary directory with a unique name.
 */
export function createTmpDir(): TmpRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on Windows
      }
    },
  };
}

const KB_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Record templates that ship in no install layer (WK-0261 Resolutions row 3) plus
 * `handoff.md`, which ships only once the dispatch layer is active. Neither
 * `bootstrap` nor `sync-contract` ever writes these to a real consumer repo
 * outside their layer — but the functions that read them (`create`, `importPlan`,
 * `validatePlan`, `archivePlan`) are unaffected by the shipping-boundary question,
 * so `createBootstrappedRepo` seeds them directly here, bypassing the layer gate,
 * to keep that large pre-existing test surface working as "a repo where every
 * wiki-core capability is available." Tests that exercise the layer gate itself
 * call `bootstrap`/`sync` directly instead (see tests/planning-layer.test.ts and
 * the WK-0261 layer-partition tests), never this helper.
 */
const NO_LAYER_OR_DISPATCH_TEMPLATES = [
  'chain-doc.md',
  'plan.md',
  'plan-execution-tracker.md',
  'value.md',
  'handoff.md',
];

/**
 * Create a temporary directory and run bootstrap to set up a minimal wiki.
 */
export async function createBootstrappedRepo(repo = 'test/repo'): Promise<TmpRepo> {
  const tmp = createTmpDir();
  const result = await bootstrap({ dir: tmp.dir, repo });
  if (!result.ok) {
    tmp.cleanup();
    throw new Error(`Bootstrap failed: ${result.message}`);
  }

  const templateDir = path.join(tmp.dir, 'wiki', 'templates');
  for (const name of NO_LAYER_OR_DISPATCH_TEMPLATES) {
    const dest = path.join(templateDir, name);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(KB_ROOT, 'contract', 'templates', name), dest);
    }
  }

  return tmp;
}

/**
 * Create a bootstrapped repo with the planning layer active (`init-planning` +
 * `sync-contract`), so planning-gated surfaces (escalation.md, the
 * `contract/skills/` repo copies, the guidelines/footer block sections) are
 * actually delivered by the real bootstrap/sync pipeline — used by tests that
 * exercise that delivery itself, as opposed to `createBootstrappedRepo`'s
 * bypass-the-gate convenience fixture.
 */
export async function createPlanningRepo(repo = 'test/repo'): Promise<TmpRepo> {
  const tmp = await createBootstrappedRepo(repo);
  const init = initPlanning({ dir: tmp.dir });
  if (!init.ok) {
    tmp.cleanup();
    throw new Error(`initPlanning failed: ${init.message}`);
  }
  const result = await sync({ dir: tmp.dir });
  if (!result.ok) {
    tmp.cleanup();
    throw new Error(`sync failed: ${result.message}`);
  }
  return tmp;
}

/**
 * Write a markdown file with frontmatter into the target directory.
 */
export function writeRecord(
  dir: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body = '',
): string {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  let yaml = '---\n';
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        yaml += `${key}: []\n`;
      } else {
        yaml += `${key}:\n`;
        for (const item of value) {
          yaml += `  - ${JSON.stringify(String(item))}\n`;
        }
      }
    } else if (typeof value === 'boolean') {
      yaml += `${key}: ${value}\n`;
    } else if (value === undefined || value === null) {
      yaml += `${key}:\n`;
    } else {
      yaml += `${key}: ${JSON.stringify(String(value))}\n`;
    }
  }
  yaml += '---\n\n';
  yaml += body;

  fs.writeFileSync(absPath, yaml, 'utf-8');
  return absPath;
}

/**
 * Read a JSON file from the target directory.
 */
export function readJson<T = unknown>(dir: string, relPath: string): T {
  const absPath = path.join(dir, relPath);
  return JSON.parse(fs.readFileSync(absPath, 'utf-8')) as T;
}

/**
 * Check if a file exists in the target directory.
 */
export function fileExists(dir: string, relPath: string): boolean {
  return fs.existsSync(path.join(dir, relPath));
}

/**
 * Read a file as text from the target directory.
 */
export function readText(dir: string, relPath: string): string {
  return fs.readFileSync(path.join(dir, relPath), 'utf-8');
}
