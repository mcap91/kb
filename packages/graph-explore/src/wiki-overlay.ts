/**
 * Wiki overlay extraction.
 *
 * Extracts edges from wiki record frontmatter fields and
 * markdown links in record bodies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphEdge, EdgeRelation } from './types.js';

// ---------------------------------------------------------------------------
// Frontmatter field -> edge relation mapping
// ---------------------------------------------------------------------------

const FRONTMATTER_EDGE_MAP: Record<string, EdgeRelation> = {
  repo_paths: 'repo_path',
  docs: 'doc',
  depends_on: 'depends_on',
  blocks: 'blocks',
  related: 'related',
  area: 'area',
  initiative: 'initiative',
};

// ---------------------------------------------------------------------------
// Simple YAML frontmatter parser
// ---------------------------------------------------------------------------

interface ParsedRecord {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the frontmatter fields and the body content.
 */
export function parseRecord(content: string): ParsedRecord {
  const fm: Record<string, unknown> = {};
  let body = content;

  if (!content.startsWith('---')) {
    return { frontmatter: fm, body };
  }

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: fm, body };
  }

  const fmBlock = content.slice(4, endIndex);
  body = content.slice(endIndex + 4).trim();

  // Simple line-by-line YAML parsing
  const lines = fmBlock.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item continuation
    if (trimmed.startsWith('- ') && currentArray !== null) {
      let value = trimmed.slice(2).trim();
      // Remove surrounding quotes
      value = stripQuotes(value);
      currentArray.push(value);
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    // Save previous array
    if (currentArray !== null && currentKey) {
      fm[currentKey] = currentArray;
      currentArray = null;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    currentKey = key;

    if (rawValue === '' || rawValue === '[]') {
      // Could be start of array or empty value
      currentArray = [];
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      if (inner.trim() === '') {
        fm[key] = [];
      } else {
        fm[key] = inner.split(',').map(s => stripQuotes(s.trim()));
      }
      currentArray = null;
      continue;
    }

    // Scalar value
    fm[key] = stripQuotes(rawValue);
    currentArray = null;
  }

  // Save last array
  if (currentArray !== null && currentKey) {
    fm[currentKey] = currentArray;
  }

  return { frontmatter: fm, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Markdown link extraction
// ---------------------------------------------------------------------------

/**
 * Extract repo-local markdown links from body content.
 * Returns target paths (repo-relative).
 */
export function extractMarkdownLinks(body: string): string[] {
  const links: string[] = [];
  // Match [text](target) links, excluding URLs
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(body)) !== null) {
    const target = match[2].trim();
    // Skip external URLs
    if (target.startsWith('http://') || target.startsWith('https://') ||
        target.startsWith('mailto:') || target.startsWith('#')) {
      continue;
    }
    // Normalize the path and remove anchors
    const cleanTarget = target.split('#')[0].trim();
    if (cleanTarget) {
      links.push(cleanTarget.replace(/\\/g, '/'));
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract wiki overlay edges from a single wiki record file.
 */
export function extractWikiEdges(
  recordRelPath: string,
  repoRoot: string,
): GraphEdge[] {
  const absPath = path.join(repoRoot, recordRelPath);
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const { frontmatter, body } = parseRecord(content);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  // Extract edges from frontmatter fields
  for (const [field, relation] of Object.entries(FRONTMATTER_EDGE_MAP)) {
    const value = frontmatter[field];
    if (value === undefined || value === null) continue;

    const targets = Array.isArray(value) ? value : [value];
    for (const target of targets) {
      const targetStr = String(target).replace(/\\/g, '/');
      if (!targetStr) continue;
      const edgeKey = `${relation}:${targetStr}`;
      if (!seen.has(edgeKey)) {
        seen.add(edgeKey);
        edges.push({
          source: recordRelPath,
          target: targetStr,
          relation,
        });
      }
    }
  }

  // Extract markdown links from body
  const mdLinks = extractMarkdownLinks(body);
  for (const target of mdLinks) {
    const edgeKey = `markdown_link:${target}`;
    if (!seen.has(edgeKey)) {
      seen.add(edgeKey);
      edges.push({
        source: recordRelPath,
        target: target,
        relation: 'markdown_link',
      });
    }
  }

  return edges;
}

/**
 * Extract all wiki overlay edges from an array of wiki record paths.
 */
export function extractAllWikiEdges(
  wikiRecords: string[],
  repoRoot: string,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const record of wikiRecords) {
    edges.push(...extractWikiEdges(record, repoRoot));
  }
  return edges;
}
