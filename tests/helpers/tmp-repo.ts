/**
 * Test helper: creates a temporary directory with a minimal wiki structure.
 *
 * Runs bootstrap programmatically to set up the directory structure,
 * or allows manual setup for specific test scenarios.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../../packages/wiki-core/src/index.js';

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
