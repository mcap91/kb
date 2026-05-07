/**
 * Wiki search module.
 *
 * Provides two main operations:
 *   1. buildSearchIndex - scans canonical content and writes wiki/.search-index.json
 *   2. search - queries the index with lexical matching and relevance ranking
 *
 * Included content:
 *   - Manifest-driven wiki records (WK, IN, DEC, SRC, AREA files)
 *   - docs/**\/*.md
 *   - Root README.md, AGENTS.md, CLAUDE.md (when present)
 *
 * Excluded content:
 *   - Generated wiki views (catalog.md, now.md, inbox.md, backlog.md, archive.md)
 *   - wiki/handoffs/
 *   - .agent-runs/
 *   - scratch_space/
 *   - node_modules/
 *   - dist/
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  BuildSearchIndexOpts,
  BuildSearchIndexResult,
  SearchHit,
  SearchOpts,
  SearchResult,
  WikiManifest,
} from './types.js';
import { loadManifest } from './contract.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the search index. */
interface SearchIndexEntry {
  id: string;
  path: string;
  title: string;
  content: string;
  prefix?: string;
  status?: string;
  terms: Record<string, number>;
}

/** The persisted search index shape. */
interface SearchIndex {
  version: string;
  builtAt: string;
  sourceSignature: string;
  entries: SearchIndexEntry[];
}

interface SearchSourceFile {
  absPath: string;
  relPath: string;
  kind: 'wiki' | 'doc' | 'root';
  prefix?: string;
}

const SEARCH_INDEX_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Frontmatter parsing (same lightweight approach as lint/generate)
// ---------------------------------------------------------------------------

function parseFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(4, endIdx);
  const body = trimmed.slice(endIdx + 4);
  const data: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    if (currentKey && currentArray !== null) {
      const arrayItemMatch = line.match(/^  ?- (.*)$/);
      if (arrayItemMatch) {
        const val = arrayItemMatch[1].trim().replace(/^["']|["']$/g, '');
        if (val) currentArray.push(val);
        continue;
      }
      data[currentKey] = currentArray.length > 0 ? currentArray : undefined;
      currentArray = null;
      currentKey = null;
    }

    const kvMatch = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (kvMatch) {
      const key = kvMatch[1];
      let value: unknown = kvMatch[2].trim();

      if (value === '' || value === 'null' || value === '~') {
        currentKey = key;
        currentArray = [];
        continue;
      }

      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
          data[key] = undefined;
        } else {
          data[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        }
        continue;
      }

      if (typeof value === 'string') {
        value = value.replace(/^["']|["']$/g, '');
      }

      if (value === 'true') value = true;
      else if (value === 'false') value = false;

      data[key] = value;
      continue;
    }
  }

  if (currentKey && currentArray !== null) {
    data[currentKey] = currentArray.length > 0 ? currentArray : undefined;
  }

  return { data, body };
}

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------

/**
 * Tokenize text into lowercase terms.
 * Splits on whitespace/punctuation, lowercases, removes short tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

/**
 * Build term frequency map from text.
 */
function buildTermFrequency(text: string): Record<string, number> {
  const terms: Record<string, number> = {};
  for (const token of tokenize(text)) {
    terms[token] = (terms[token] || 0) + 1;
  }
  return terms;
}

/**
 * Extract a title from markdown content.
 * Looks for a level-1 heading, falls back to the first heading of any level.
 */
function extractTitle(body: string, fallback: string): string {
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  const hAny = body.match(/^#{1,6}\s+(.+)$/m);
  if (hAny) return hAny[1].trim();
  return fallback;
}

/**
 * Strip frontmatter from raw markdown, returning just the body.
 */
function stripFrontmatter(raw: string): string {
  const parsed = parseFrontmatter(raw);
  return parsed ? parsed.body : raw;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/** List markdown files in a directory (non-recursive). */
function listMarkdownFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs
      .readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dirPath, f));
  } catch {
    return [];
  }
}

/**
 * Recursively list markdown files in a directory.
 * Respects the exclusion list.
 */
function listMarkdownFilesRecursive(dirPath: string, excludeDirs: Set<string>): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          results.push(...listMarkdownFilesRecursive(fullPath, excludeDirs));
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore read errors
  }

  return results;
}

function collectSearchSourceFiles(targetDir: string, manifest: WikiManifest): SearchSourceFile[] {
  const generatedViewFiles = new Set(
    manifest.generatedViews.standardFiles.map(f =>
      path.resolve(targetDir, f.replace(/\//g, path.sep)),
    ),
  );

  const files: SearchSourceFile[] = [];

  for (const [typeKey, typeDef] of Object.entries(manifest.types)) {
    const dir = path.join(targetDir, typeDef.directory.replace(/\//g, path.sep));
    const recordFiles = listMarkdownFiles(dir);

    for (const absPath of recordFiles) {
      const basename = path.basename(absPath);

      if (typeDef.reservedFilenames.includes(basename)) continue;
      if (generatedViewFiles.has(path.resolve(absPath))) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const parsed = parseFrontmatter(raw);
      if (parsed && (parsed.data['_generated'] === true || parsed.data['_generated'] === 'true')) {
        continue;
      }

      files.push({
        absPath,
        relPath: path.relative(targetDir, absPath).replace(/\\/g, '/'),
        kind: 'wiki',
        prefix: typeDef.prefix || typeKey.toUpperCase(),
      });
    }
  }

  const docsDir = path.join(targetDir, 'docs');
  const excludeDirs = new Set(['node_modules', 'dist', '.agent-runs', 'scratch_space']);
  const docFiles = listMarkdownFilesRecursive(docsDir, excludeDirs);
  for (const absPath of docFiles) {
    files.push({
      absPath,
      relPath: path.relative(targetDir, absPath).replace(/\\/g, '/'),
      kind: 'doc',
    });
  }

  const rootFiles = ['README.md', 'AGENTS.md', 'CLAUDE.md'];
  for (const filename of rootFiles) {
    const absPath = path.join(targetDir, filename);
    if (!fs.existsSync(absPath)) continue;
    files.push({
      absPath,
      relPath: filename,
      kind: 'root',
    });
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function computeSearchSourceSignature(files: SearchSourceFile[]): string {
  const hash = createHash('sha256');

  for (const file of files) {
    try {
      const stats = fs.statSync(file.absPath);
      hash.update(file.relPath);
      hash.update(':');
      hash.update(String(stats.mtimeMs));
      hash.update(':');
      hash.update(String(stats.size));
      hash.update('\n');
    } catch {
      // Ignore files that disappear during signature computation.
    }
  }

  return hash.digest('hex');
}

function readSearchIndex(indexPath: string): Result<SearchIndex> {
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    return ok(JSON.parse(raw) as SearchIndex);
  } catch (err) {
    return fail(
      'SEARCH_ERROR',
      `Failed to parse search index: ${String(err)}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Build Search Index
// ---------------------------------------------------------------------------

/**
 * Build a search index over canonical content in the target repo.
 *
 * Scans manifest-driven wiki records, docs/**\/*.md, and root README/AGENTS/CLAUDE.
 * Writes the index to wiki/.search-index.json.
 */
export async function buildSearchIndex(
  opts: BuildSearchIndexOpts,
): Promise<Result<BuildSearchIndexResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');

  debug(`buildSearchIndex: target=${targetDir}`);

  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  const entries: SearchIndexEntry[] = [];
  const sourceFiles = collectSearchSourceFiles(targetDir, manifest);

  for (const source of sourceFiles) {
    const raw = fs.readFileSync(source.absPath, 'utf-8');

    if (source.kind === 'wiki') {
      const parsed = parseFrontmatter(raw);
      const fm = parsed?.data || {};
      const body = parsed ? parsed.body : raw;
      const id = typeof fm['id'] === 'string'
        ? fm['id']
        : path.basename(source.absPath, '.md');
      const title = typeof fm['title'] === 'string' ? fm['title'] : extractTitle(body, id);
      const status = typeof fm['status'] === 'string' ? fm['status'] : undefined;
      const searchableText = `${title} ${body}`;
      const terms = buildTermFrequency(searchableText);

      entries.push({
        id,
        path: source.relPath,
        title,
        content: body.slice(0, 500),
        prefix: source.prefix,
        status,
        terms,
      });

      debug(`indexed wiki record: ${source.relPath}`);
      continue;
    }

    const body = stripFrontmatter(raw);
    const fallback = path.basename(source.relPath, '.md');
    const title = extractTitle(body, fallback);
    const searchableText = `${title} ${body}`;
    const terms = buildTermFrequency(searchableText);

    entries.push({
      id: source.relPath,
      path: source.relPath,
      title,
      content: body.slice(0, 500),
      terms,
    });

    debug(`indexed ${source.kind}: ${source.relPath}`);
  }

  const index: SearchIndex = {
    version: SEARCH_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sourceSignature: computeSearchSourceSignature(sourceFiles),
    entries,
  };

  const indexPath = path.join(wikiDir, '.search-index.json');

  if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true });
  }

  try {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  } catch (err) {
    return fail(
      'SEARCH_ERROR',
      `Failed to write search index: ${String(err)}`,
      err,
    );
  }

  const relIndexPath = path.relative(targetDir, indexPath).replace(/\\/g, '/');
  debug(`buildSearchIndex: indexed ${entries.length} files, wrote ${relIndexPath}`);

  return ok({ indexed: entries.length, path: relIndexPath });
}

async function ensureFreshSearchIndex(
  targetDir: string,
  verbose?: boolean,
): Promise<Result<SearchIndex>> {
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }

  const sourceFiles = collectSearchSourceFiles(targetDir, manifestResult.data);
  const currentSignature = computeSearchSourceSignature(sourceFiles);
  const indexPath = path.join(targetDir, 'wiki', '.search-index.json');

  if (!fs.existsSync(indexPath)) {
    return fail(
      'SEARCH_ERROR',
      `Search index not found at ${indexPath} — run buildSearchIndex first`,
    );
  }

  const existingResult = readSearchIndex(indexPath);
  if (!existingResult.ok) {
    return existingResult;
  }

  const existing = existingResult.data;
  const isStale =
    existing.version !== SEARCH_INDEX_VERSION ||
    existing.sourceSignature !== currentSignature;

  if (!isStale) {
    return ok(existing);
  }

  debug(`search index stale at ${indexPath}; rebuilding`);
  const rebuildResult = await buildSearchIndex({ dir: targetDir, verbose });
  if (!rebuildResult.ok) {
    return fail(rebuildResult.error, rebuildResult.message, rebuildResult.detail);
  }

  return readSearchIndex(indexPath);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Query the search index with lexical matching.
 *
 * - Refreshes the persisted index if canonical sources changed
 * - Tokenizes the query
 * - Scores each entry by term frequency overlap
 * - Returns ranked results with snippets
 */
export async function search(
  opts: SearchOpts,
): Promise<Result<SearchResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);

  debug(`search: query="${opts.query}", dir=${targetDir}`);

  const indexResult = await ensureFreshSearchIndex(targetDir, opts.verbose);
  if (!indexResult.ok) {
    return indexResult;
  }
  const index = indexResult.data;

  const queryTerms = tokenize(opts.query);
  if (queryTerms.length === 0) {
    return ok({ hits: [], total: 0, query: opts.query });
  }

  const scored: Array<{ entry: SearchIndexEntry; score: number }> = [];

  for (const entry of index.entries) {
    if (opts.prefix && entry.prefix !== opts.prefix) continue;
    if (opts.status && entry.status !== opts.status) continue;

    let score = 0;
    const titleLower = entry.title.toLowerCase();

    for (const term of queryTerms) {
      const termFreq = entry.terms[term] || 0;
      if (termFreq > 0) {
        score += termFreq;
      }

      if (titleLower.includes(term)) {
        score += 5;
      }

      if (entry.id.toLowerCase().includes(term)) {
        score += 3;
      }
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const limit = opts.limit ?? 20;
  const top = scored.slice(0, limit);

  const hits: SearchHit[] = top.map(({ entry, score }) => {
    let snippet: string | undefined;
    const contentLower = entry.content.toLowerCase();
    for (const term of queryTerms) {
      const idx = contentLower.indexOf(term);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(entry.content.length, idx + term.length + 60);
        snippet = (start > 0 ? '...' : '') +
          entry.content.slice(start, end).trim() +
          (end < entry.content.length ? '...' : '');
        break;
      }
    }

    return {
      id: entry.id,
      path: entry.path,
      title: entry.title,
      score,
      prefix: entry.prefix,
      snippet,
    };
  });

  debug(`search: ${hits.length} hits for "${opts.query}"`);

  return ok({ hits, total: scored.length, query: opts.query });
}
