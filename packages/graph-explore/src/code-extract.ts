/**
 * Deterministic file/module-level code import extraction.
 *
 * Supports:
 * - TypeScript / JavaScript: import, export-from, require()
 * - Python: import, from-import
 *
 * Rules:
 * - Only repo-local references become edges
 * - External/unresolved modules are ignored
 * - No AST required; uses regex
 * - No function-level or symbol-level tracing
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphEdge } from './types.js';

// ---------------------------------------------------------------------------
// TS/JS extraction
// ---------------------------------------------------------------------------

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXTENSIONS = new Set(['.py']);

/**
 * Regex patterns for TS/JS import extraction.
 * These cover:
 * - import ... from '...'
 * - export ... from '...'
 * - require('...')
 */
const TS_IMPORT_PATTERNS = [
  // import ... from '...' or "..."
  /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
  // export ... from '...' or "..."
  /(?:^|\n)\s*export\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
  // require('...') or require("...")
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Regex patterns for Python import extraction.
 * These cover:
 * - import module
 * - import module.submodule
 * - from module import ...
 * - from module.submodule import ...
 */
const PY_IMPORT_PATTERNS = [
  // from module import ... (captures the module part)
  /(?:^|\n)\s*from\s+([\w.]+)\s+import\s/g,
  // import module (captures the module; handles comma-separated)
  /(?:^|\n)\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/g,
];

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Check if a TS/JS import specifier is repo-local (relative path or workspace ref).
 */
function isTsLocalSpecifier(specifier: string): boolean {
  // Relative imports
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
  // Workspace package references (start with @kb/)
  if (specifier.startsWith('@kb/')) return true;
  return false;
}

/**
 * Resolve a TS/JS import specifier to a repo-relative file path.
 * Returns null if the target doesn't exist in the repo.
 */
export function resolveTsImport(
  specifier: string,
  sourceFileRel: string,
  repoRoot: string,
): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolveRelativeImport(specifier, sourceFileRel, repoRoot);
  }

  // Workspace package references like @kb/wiki-core
  if (specifier.startsWith('@kb/')) {
    const pkgName = specifier.slice(4).split('/')[0];
    const subPath = specifier.slice(4 + pkgName.length);
    const basePath = `packages/${pkgName}/src${subPath || '/index'}`;
    return resolveWithExtensions(basePath, repoRoot);
  }

  return null;
}

/**
 * Resolve a relative import to a repo-relative file path.
 */
function resolveRelativeImport(
  specifier: string,
  sourceFileRel: string,
  repoRoot: string,
): string | null {
  const sourceDir = path.dirname(sourceFileRel);
  const joined = path.posix.join(sourceDir, specifier);
  return resolveWithExtensions(joined, repoRoot);
}

/**
 * Try to resolve a path by appending common extensions or /index variants.
 * Returns the repo-relative path if found, null otherwise.
 */
function resolveWithExtensions(basePath: string, repoRoot: string): string | null {
  // Normalize to forward slashes
  const normalized = basePath.replace(/\\/g, '/');

  // Remove trailing .js/.ts extension from specifier (common in ESM)
  const stripped = normalized.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');

  const candidates = [
    normalized,
    stripped + '.ts',
    stripped + '.tsx',
    stripped + '.js',
    stripped + '.jsx',
    stripped + '.mjs',
    stripped + '.cjs',
    stripped + '/index.ts',
    stripped + '/index.tsx',
    stripped + '/index.js',
    stripped + '/index.jsx',
  ];

  for (const candidate of candidates) {
    const absPath = path.join(repoRoot, candidate);
    try {
      if (fs.statSync(absPath).isFile()) {
        return candidate;
      }
    } catch {
      // File doesn't exist, try next
    }
  }

  return null;
}

/**
 * Resolve a Python module path to a repo-relative file path.
 * Returns null if the module is not repo-local.
 */
export function resolvePyImport(
  modulePath: string,
  sourceFileRel: string,
  repoRoot: string,
): string | null {
  // Convert dot notation to path segments
  const parts = modulePath.split('.');
  const relPath = parts.join('/');

  // Try as a direct .py file
  const candidates = [
    relPath + '.py',
    relPath + '/__init__.py',
  ];

  for (const candidate of candidates) {
    const absPath = path.join(repoRoot, candidate);
    try {
      if (fs.statSync(absPath).isFile()) {
        return candidate.replace(/\\/g, '/');
      }
    } catch {
      // File doesn't exist
    }
  }

  // Try relative to the source file's directory
  const sourceDir = path.dirname(sourceFileRel);
  for (const candidate of candidates) {
    const relToSource = path.posix.join(sourceDir, candidate);
    const absPath = path.join(repoRoot, relToSource);
    try {
      if (fs.statSync(absPath).isFile()) {
        return relToSource.replace(/\\/g, '/');
      }
    } catch {
      // File doesn't exist
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract import edges from a single source file.
 */
export function extractImports(
  sourceFileRel: string,
  repoRoot: string,
): GraphEdge[] {
  const ext = path.extname(sourceFileRel).toLowerCase();
  const absPath = path.join(repoRoot, sourceFileRel);

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  if (TS_JS_EXTENSIONS.has(ext)) {
    for (const pattern of TS_IMPORT_PATTERNS) {
      // Reset regex state
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const specifier = match[1];
        if (!isTsLocalSpecifier(specifier)) continue;
        const resolved = resolveTsImport(specifier, sourceFileRel, repoRoot);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          edges.push({
            source: sourceFileRel,
            target: resolved,
            relation: 'imports',
          });
        }
      }
    }
  } else if (PY_EXTENSIONS.has(ext)) {
    for (const pattern of PY_IMPORT_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const rawModule = match[1];
        // Handle comma-separated imports: import a, b, c
        const modules = rawModule.split(/\s*,\s*/);
        for (const mod of modules) {
          const trimmed = mod.trim();
          if (!trimmed) continue;
          const resolved = resolvePyImport(trimmed, sourceFileRel, repoRoot);
          if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            edges.push({
              source: sourceFileRel,
              target: resolved,
              relation: 'imports',
            });
          }
        }
      }
    }
  }

  return edges;
}

/**
 * Extract all import edges from an array of code file nodes.
 */
export function extractAllImports(
  codeFiles: string[],
  repoRoot: string,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const file of codeFiles) {
    edges.push(...extractImports(file, repoRoot));
  }
  return edges;
}
