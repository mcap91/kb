/**
 * View generation module.
 *
 * Generates 5 standard non-canonical wiki views from manifest-driven records:
 *   - wiki/catalog.md  — complete listing of all records by type
 *   - wiki/now.md      — active / in-progress work items
 *   - wiki/inbox.md    — new / untriaged items
 *   - wiki/backlog.md  — planned but not yet active items
 *   - wiki/archive.md  — closed / completed items
 *
 * Each generated file includes `_generated: true` in its frontmatter so that
 * lint and other tools can identify and skip generated views.
 *
 * Scope:
 *   - Reads only manifest-driven record directories (WK, IN, DEC, SRC, AREA, PLN)
 *   - Excludes wiki/handoffs/
 *   - Includes PLN in catalog only; work-tracking views exclude plans
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  GenerateOpts,
  GenerateResult,
  ManifestRecordType,
} from './types.js';
import { loadManifest } from './contract.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Frontmatter parsing (lightweight, same approach as lint)
// ---------------------------------------------------------------------------

function parseFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const trimmed = raw.replace(/^﻿/, '');
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
// Record collection
// ---------------------------------------------------------------------------

interface RecordEntry {
  id: string;
  title: string;
  status: string;
  relPath: string;
  typeLabel: string;
  prefix: string;
  priority?: string;
}

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
 * Collect all manifest-driven wiki records with their parsed frontmatter.
 */
function collectRecords(
  targetDir: string,
  wikiDir: string,
  manifest: { types: Record<string, ManifestRecordType> },
): RecordEntry[] {
  const entries: RecordEntry[] = [];

  for (const [typeKey, typeDef] of Object.entries(manifest.types)) {
    const dir = path.join(targetDir, typeDef.directory.replace(/\//g, path.sep));
    const files = listMarkdownFiles(dir);

    for (const absPath of files) {
      const basename = path.basename(absPath);

      // Skip reserved filenames
      if (typeDef.reservedFilenames.includes(basename)) continue;

      const raw = fs.readFileSync(absPath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      const fm = parsed.data;

      // Skip generated views
      if (fm['_generated'] === true || fm['_generated'] === 'true') continue;

      const id = typeof fm['id'] === 'string' ? fm['id'] : basename.replace('.md', '');
      const title = typeof fm['title'] === 'string' ? fm['title'] : id;
      const status = typeof fm['status'] === 'string' ? fm['status'] : '';
      const priority = typeof fm['priority'] === 'string' ? fm['priority'] : undefined;
      const prefix = typeDef.prefix || typeKey.toUpperCase();
      const relPath = path.relative(wikiDir, absPath).replace(/\\/g, '/');

      entries.push({
        id,
        title,
        status,
        relPath,
        typeLabel: typeKey,
        prefix,
        priority,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// View builders
// ---------------------------------------------------------------------------

/** Generated frontmatter marker block. */
function generatedFrontmatter(title: string): string {
  return `---
_generated: true
title: "${title}"
updated: "${new Date().toISOString()}"
---

`;
}

/** Format a single record as a markdown table row. */
function tableRow(rec: RecordEntry): string {
  return `| [${rec.id}](${rec.relPath}) | ${rec.title} | ${rec.status || '-'} | ${rec.priority || '-'} | ${rec.prefix} |`;
}

/** Table header. */
const TABLE_HEADER =
  '| ID | Title | Status | Priority | Type |\n| --- | --- | --- | --- | --- |';

/** Build catalog.md content. */
function buildCatalog(records: RecordEntry[]): string {
  let content = generatedFrontmatter('Catalog');
  content += '# Catalog\n\n';
  content += 'Complete listing of all wiki records by type.\n\n';

  // Group by type
  const byType = new Map<string, RecordEntry[]>();
  for (const rec of records) {
    const list = byType.get(rec.typeLabel) || [];
    list.push(rec);
    byType.set(rec.typeLabel, list);
  }

  for (const [typeLabel, recs] of byType.entries()) {
    content += `## ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)}s\n\n`;
    if (recs.length === 0) {
      content += '_No records._\n\n';
    } else {
      content += TABLE_HEADER + '\n';
      for (const rec of recs) {
        content += tableRow(rec) + '\n';
      }
      content += '\n';
    }
  }

  return content;
}

/** Build now.md content — active / in-progress items. */
function buildNow(records: RecordEntry[]): string {
  const activeStatuses = new Set(['in_progress', 'review', 'blocked']);
  const active = records.filter(r => activeStatuses.has(r.status));

  let content = generatedFrontmatter('Now');
  content += '# Now\n\n';
  content += 'Active and in-progress work items.\n\n';

  if (active.length === 0) {
    content += '_No active items._\n';
  } else {
    content += TABLE_HEADER + '\n';
    for (const rec of active) {
      content += tableRow(rec) + '\n';
    }
  }

  content += '\n';
  return content;
}

/** Build inbox.md content — new / untriaged items. */
function buildInbox(records: RecordEntry[]): string {
  const inboxStatuses = new Set(['inbox', 'proposed']);
  const inbox = records.filter(r => inboxStatuses.has(r.status));

  let content = generatedFrontmatter('Inbox');
  content += '# Inbox\n\n';
  content += 'New and untriaged items.\n\n';

  if (inbox.length === 0) {
    content += '_No inbox items._\n';
  } else {
    content += TABLE_HEADER + '\n';
    for (const rec of inbox) {
      content += tableRow(rec) + '\n';
    }
  }

  content += '\n';
  return content;
}

/** Build backlog.md content — planned but not yet active items. */
function buildBacklog(records: RecordEntry[]): string {
  const backlogStatuses = new Set(['todo', 'parked']);
  const backlog = records.filter(r => backlogStatuses.has(r.status));

  let content = generatedFrontmatter('Backlog');
  content += '# Backlog\n\n';
  content += 'Planned but not yet active items.\n\n';

  if (backlog.length === 0) {
    content += '_No backlog items._\n';
  } else {
    content += TABLE_HEADER + '\n';
    for (const rec of backlog) {
      content += tableRow(rec) + '\n';
    }
  }

  content += '\n';
  return content;
}

/** Build archive.md content — closed / completed items. */
function buildArchive(records: RecordEntry[]): string {
  const archiveStatuses = new Set([
    'done',
    'closed',
    'cancelled',
    'deprecated',
    'duplicate',
    'superseded',
    'wont_do',
    'accepted',
    'rejected',
  ]);
  const archived = records.filter(r => archiveStatuses.has(r.status));

  let content = generatedFrontmatter('Archive');
  content += '# Archive\n\n';
  content += 'Closed and completed items.\n\n';

  if (archived.length === 0) {
    content += '_No archived items._\n';
  } else {
    content += TABLE_HEADER + '\n';
    for (const rec of archived) {
      content += tableRow(rec) + '\n';
    }
  }

  content += '\n';
  return content;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

/**
 * Generate all standard non-canonical wiki views.
 *
 * Writes 5 files under wiki/ in the target directory, each with a
 * `_generated: true` frontmatter marker.
 */
export async function generate(
  opts: GenerateOpts,
): Promise<Result<GenerateResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');
  debug(`generate: target=${targetDir}`);

  // 1. Load manifest
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  // 2. Collect all manifest-driven records
  const records = collectRecords(targetDir, wikiDir, manifest);
  const workTrackingRecords = records.filter(r => r.prefix !== 'PLN');
  debug(`generate: collected ${records.length} records`);

  // 3. Build and write each view
  const views: Array<{
    filename: string;
    builder: (recs: RecordEntry[]) => string;
    includePlans?: boolean;
  }> = [
    { filename: 'catalog.md', builder: buildCatalog, includePlans: true },
    { filename: 'now.md', builder: buildNow },
    { filename: 'inbox.md', builder: buildInbox },
    { filename: 'backlog.md', builder: buildBacklog },
    { filename: 'archive.md', builder: buildArchive },
  ];

  const generated: string[] = [];

  // Ensure wiki directory exists
  if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true });
  }

  for (const view of views) {
    const content = view.builder(view.includePlans ? records : workTrackingRecords);
    const filePath = path.join(wikiDir, view.filename);

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      const relPath = `wiki/${view.filename}`;
      generated.push(relPath);
      debug(`generate: wrote ${relPath}`);
    } catch (err) {
      return fail(
        'GENERATE_ERROR',
        `Failed to write ${view.filename}: ${String(err)}`,
        err,
      );
    }
  }

  return ok({ generated });
}
