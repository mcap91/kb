/**
 * File scanner for graph extraction.
 *
 * Walks a target directory, classifies files into node kinds,
 * and excludes paths that are out of scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphNode, GraphWikiPrefix } from './types.js';

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/** Directories excluded from graph scanning (slash-terminated for prefix matching). */
const EXCLUDED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  '.agent-runs',
  'scratch_space',
  'wiki/handoffs',
];

/** Generated wiki views excluded from scanning. */
const GENERATED_VIEWS = new Set([
  'wiki/catalog.md',
  'wiki/now.md',
  'wiki/inbox.md',
  'wiki/backlog.md',
  'wiki/archive.md',
]);

/** Runtime / hidden files excluded from scanning. */
const HIDDEN_FILES = new Set([
  'wiki/.wiki-contract.json',
  'wiki/.id-state.json',
  'wiki/.search-index.json',
  'wiki/.graph.json',
]);

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.scala',
  '.sh', '.bash', '.zsh', '.ps1',
  '.css', '.scss', '.less', '.sass',
  '.json', '.yaml', '.yml', '.toml',
]);

const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst']);

// ---------------------------------------------------------------------------
// Wiki directory mapping
// ---------------------------------------------------------------------------

const WIKI_PREFIX_MAP: Record<string, GraphWikiPrefix> = {
  'wiki/issues': 'WK',
  'wiki/initiatives': 'IN',
  'wiki/decisions': 'DEC',
  'wiki/sources': 'SRC',
  'wiki/areas': 'AREA',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a repo-relative path should be excluded from scanning.
 */
export function isExcluded(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');

  // Exclude hidden files
  if (HIDDEN_FILES.has(normalized)) return true;

  // Exclude generated views
  if (GENERATED_VIEWS.has(normalized)) return true;

  // Exclude directories
  for (const dir of EXCLUDED_DIRS) {
    if (normalized === dir || normalized.startsWith(dir + '/')) {
      return true;
    }
  }

  // Exclude graph summary
  if (normalized === 'wiki/graph-summary.md') return true;

  return false;
}

/**
 * Classify a file into a graph node kind based on its repo-relative path.
 * Returns null if the file should not be a node.
 */
export function classifyFile(relPath: string): GraphNode | null {
  const normalized = relPath.replace(/\\/g, '/');

  if (isExcluded(normalized)) return null;

  const ext = path.extname(normalized).toLowerCase();

  // Check if it's a wiki record
  for (const [dir, prefix] of Object.entries(WIKI_PREFIX_MAP)) {
    if (normalized.startsWith(dir + '/') && ext === '.md') {
      const basename = path.basename(normalized);
      // Skip README.md in wiki directories
      if (basename === 'README.md') continue;
      const title = extractTitleFromBasename(basename);
      return {
        id: normalized,
        kind: 'wiki_record',
        title,
        prefix,
        exists: true,
      };
    }
  }

  // Check if it's a doc file (markdown outside wiki record dirs, or docs/ dir)
  if (DOC_EXTENSIONS.has(ext)) {
    return {
      id: normalized,
      kind: 'doc_file',
      exists: true,
    };
  }

  // Check if it's a code file
  if (CODE_EXTENSIONS.has(ext)) {
    return {
      id: normalized,
      kind: 'code_file',
      exists: true,
    };
  }

  return null;
}

/**
 * Extract a human-readable title from a filename.
 */
function extractTitleFromBasename(basename: string): string {
  return basename.replace(/\.md$/, '');
}

/**
 * Recursively scan a directory and return graph nodes for all included files.
 */
export function scanDirectory(repoRoot: string): GraphNode[] {
  const nodes: GraphNode[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort for determinism
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        // Skip excluded directories early
        if (isExcluded(relPath + '/x')) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const node = classifyFile(relPath);
        if (node) {
          nodes.push(node);
        }
      }
    }
  }

  walk(repoRoot);
  return nodes;
}
