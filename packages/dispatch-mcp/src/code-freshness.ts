/**
 * Fingerprint the kb sources a kb-dispatch MCP server loads at start.
 *
 * A kb-dispatch server is a long-lived process: it loads its TypeScript sources once,
 * when its client session connects, and keeps them until that session restarts. After a
 * merge or an uncommitted edit changes those sources on disk, the running server holds
 * code older than the checkout. `fingerprintSources` hashes every file under the three
 * source trees so `createServer` can compare what it loaded against what is on disk now.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The three source trees a kb-dispatch server loads. Resolved from this module's own
 * location, never from a tool's `dir` argument. The package `main` is `src/index.ts`; if
 * this module ever runs from `dist/`, the same URLs still name the `src` trees, which is
 * the code tsx loads.
 */
export const DEFAULT_SRC_DIRS: readonly string[] = [
  fileURLToPath(new URL('../../dispatch-mcp/src', import.meta.url)),
  fileURLToPath(new URL('../../dispatch-core/src', import.meta.url)),
  fileURLToPath(new URL('../../wiki-core/src', import.meta.url)),
];

export interface SourceFingerprint {
  /** sha256 (hex) over every hashed file's path and bytes, in path order. */
  fingerprint: string;
  /** The path each hashed file was named by, default string sorted. */
  files: string[];
}

/**
 * The directory a hashed file's path is named by: two levels above the package directory
 * that owns `srcDirs` (the repo root for the real trees). Keeping the name relative to
 * that root makes the fingerprint stable when the same tree sits at a different absolute
 * path.
 */
function sourceRoot(srcDir: string): string {
  return resolve(dirname(srcDir), '..', '..');
}

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else {
      // Every entry that is not a directory is a file to read: symlinks are not skipped
      // and every file counts, whatever its extension. A dangling symlink (or one to a
      // directory) makes the read throw, and the caller refuses rather than passing.
      out.push(full);
    }
  }
}

/**
 * Walk `srcDirs` and hash every file. Reads and hashing are synchronous. Throws when a
 * file cannot be read; the thrown error carries the failing path so the caller can name
 * it in the refusal.
 */
export function fingerprintSources(srcDirs: readonly string[] = DEFAULT_SRC_DIRS): SourceFingerprint {
  const hashed: Array<{ path: string; fullPath: string }> = [];

  for (const srcDir of srcDirs) {
    const root = sourceRoot(srcDir);
    const files: string[] = [];
    collectFiles(srcDir, files);
    for (const fullPath of files) {
      hashed.push({ path: relative(root, fullPath), fullPath });
    }
  }

  // Default string sort (`<`), not localeCompare: byte order is locale-independent.
  hashed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash('sha256');
  for (const { path, fullPath } of hashed) {
    hash.update(path);
    hash.update(readFileSync(fullPath));
  }

  return { fingerprint: hash.digest('hex'), files: hashed.map((entry) => entry.path) };
}
