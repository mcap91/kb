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
 * When the planning layer is active it also writes the dashboard pages under
 * wiki/dashboard/generated/ (see `dashboard/`). The planning layer is checked
 * before anything is written; a wiki-only repo is untouched.
 *
 * Scope:
 *   - Reads only manifest-driven record directories (WK, IN, DEC, SRC, AREA, PLN, VAL)
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
import { planningInstalled } from './agent-instructions.js';
import { generateDashboard } from './dashboard/generate.js';
import type { DashboardRecord } from './dashboard/types.js';

// ---------------------------------------------------------------------------
// Frontmatter parsing (lightweight, same approach as lint)
// ---------------------------------------------------------------------------

function parseFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const trimmed = raw.replace(/\r\n/g, '\n').replace(/^﻿/, '');
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
  updated?: string;
  initiative?: string;
  depends_on: string[];
  blocks: string[];
  related: string[];
  tags: string[];
  itemType?: string;
  body: string;
  absPath: string;
  data: Record<string, unknown>;
}

/** Read a frontmatter value as a list of non-empty strings. */
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function listMarkdownFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs
      .readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort()
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
    if (typeDef.prefix === 'HO') continue;

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
        updated: typeof fm['updated'] === 'string' ? fm['updated'] : undefined,
        initiative: typeof fm['initiative'] === 'string' ? fm['initiative'] : undefined,
        depends_on: stringArray(fm['depends_on']),
        blocks: stringArray(fm['blocks']),
        related: stringArray(fm['related']),
        tags: stringArray(fm['tags']),
        itemType: typeof fm['type'] === 'string' ? fm['type'] : undefined,
        body: parsed.body,
        absPath,
        data: fm,
      });
    }
  }

  // One id wins: the record file whose path sorts first. Insertion order is kept
  // for the five views; a later duplicate with a smaller path replaces it.
  const chosen = new Map<string, RecordEntry>();
  const result: RecordEntry[] = [];
  for (const entry of entries) {
    const previous = chosen.get(entry.id);
    if (!previous) {
      chosen.set(entry.id, entry);
      result.push(entry);
      continue;
    }
    if (entry.absPath < previous.absPath) {
      const index = result.indexOf(previous);
      if (index !== -1) result[index] = entry;
      chosen.set(entry.id, entry);
    }
  }
  return result;
}

/** The work item and initiative prefixes from the manifest. */
function resolvePrefixes(
  manifest: { types: Record<string, ManifestRecordType> },
): { workItemPrefix: string; initiativePrefix: string } | null {
  const types = Object.values(manifest.types);
  const matches = (stateKey: string): ManifestRecordType | undefined =>
    types.find(t => t.stateKey === stateKey || t.aliases.includes(stateKey));
  const work = matches('work_item');
  const initiative = matches('initiative');
  if (!work?.prefix || !initiative?.prefix) return null;
  return { workItemPrefix: work.prefix, initiativePrefix: initiative.prefix };
}

/**
 * The repo display name: the part after the slash of `repo`, else the base name
 * of `dir`. Falls back to the directory name only when the contract is absent
 * (ENOENT) or has no non-empty string `repo` field; any other read or parse
 * error is returned so the caller can stop the run.
 */
function repoDisplayName(targetDir: string): Result<string> {
  const contractPath = path.join(targetDir, 'wiki', '.wiki-contract.json');

  let raw: string;
  try {
    raw = fs.readFileSync(contractPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(path.basename(targetDir));
    }
    return fail('GENERATE_ERROR', `Failed to read wiki/.wiki-contract.json: ${String(err)}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail('GENERATE_ERROR', `Failed to parse wiki/.wiki-contract.json: ${String(err)}`, err);
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const repo = (parsed as Record<string, unknown>)['repo'];
    if (typeof repo === 'string' && repo.length > 0) {
      const slash = repo.lastIndexOf('/');
      return ok(slash === -1 ? repo : repo.slice(slash + 1));
    }
  }
  return ok(path.basename(targetDir));
}

/**
 * Convert every collected record into the model the dashboard pages read: the
 * work item and initiative records the pages are built from, plus the id and
 * file path of every other record type, so a page can link one.
 */
function toDashboardRecords(records: RecordEntry[]): DashboardRecord[] {
  return records
    .map(r => ({
      id: r.id,
      prefix: r.prefix,
      typeLabel: r.typeLabel,
      title: r.title,
      status: r.status,
      priority: r.priority,
      updated: r.updated,
      initiative: r.initiative,
      depends_on: r.depends_on,
      blocks: r.blocks,
      related: r.related,
      tags: r.tags,
      itemType: r.itemType,
      absPath: r.absPath,
      relPath: r.relPath,
      body: r.body,
      data: r.data,
    }));
}

// ---------------------------------------------------------------------------
// View builders
// ---------------------------------------------------------------------------
// generated views stay git-tracked; updated: bumps only on body change (WK-0031)

/** Generated frontmatter marker block with the given timestamp. */
function generatedFrontmatter(title: string, updated: string): string {
  return `---
_generated: true
title: "${title}"
updated: "${updated}"
---

`;
}

/**
 * Read the existing view file and return its current updated timestamp and body
 * (everything after the closing frontmatter fence).  Returns null if the file
 * does not exist or cannot be parsed.
 */
function readExistingView(filePath: string): { updated: string; body: string } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    const updated = typeof parsed.data['updated'] === 'string' ? parsed.data['updated'] : null;
    if (!updated) return null;
    return { updated, body: parsed.body };
  } catch {
    return null;
  }
}

/** Format a single record as a markdown table row. */
function tableRow(rec: RecordEntry): string {
  return `| [${rec.id}](${rec.relPath}) | ${rec.title} | ${rec.status || '-'} | ${rec.priority || '-'} | ${rec.prefix} |`;
}

/** Table header. */
const TABLE_HEADER =
  '| ID | Title | Status | Priority | Type |\n| --- | --- | --- | --- | --- |';

/** Build catalog.md body (no frontmatter). */
function buildCatalog(records: RecordEntry[]): string {
  let body = '# Catalog\n\n';
  body += 'Complete listing of all wiki records by type.\n\n';

  // Group by type
  const byType = new Map<string, RecordEntry[]>();
  for (const rec of records) {
    const list = byType.get(rec.typeLabel) || [];
    list.push(rec);
    byType.set(rec.typeLabel, list);
  }

  for (const [typeLabel, recs] of byType.entries()) {
    body += `## ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)}s\n\n`;
    if (recs.length === 0) {
      body += '_No records._\n\n';
    } else {
      body += TABLE_HEADER + '\n';
      for (const rec of recs) {
        body += tableRow(rec) + '\n';
      }
      body += '\n';
    }
  }

  return body;
}

/** Build now.md body — active / in-progress items. */
function buildNow(records: RecordEntry[]): string {
  const activeStatuses = new Set(['in_progress', 'review', 'blocked']);
  const active = records.filter(r => activeStatuses.has(r.status));

  let body = '# Now\n\n';
  body += 'Active and in-progress work items.\n\n';

  if (active.length === 0) {
    body += '_No active items._\n';
  } else {
    body += TABLE_HEADER + '\n';
    for (const rec of active) {
      body += tableRow(rec) + '\n';
    }
  }

  body += '\n';
  return body;
}

/** Build inbox.md body — new / untriaged items. */
function buildInbox(records: RecordEntry[]): string {
  const inboxStatuses = new Set(['inbox', 'proposed']);
  const inbox = records.filter(r => inboxStatuses.has(r.status));

  let body = '# Inbox\n\n';
  body += 'New and untriaged items.\n\n';

  if (inbox.length === 0) {
    body += '_No inbox items._\n';
  } else {
    body += TABLE_HEADER + '\n';
    for (const rec of inbox) {
      body += tableRow(rec) + '\n';
    }
  }

  body += '\n';
  return body;
}

/** Build backlog.md body — planned but not yet active items. */
function buildBacklog(records: RecordEntry[]): string {
  const backlogStatuses = new Set(['todo', 'parked']);
  const backlog = records.filter(r => backlogStatuses.has(r.status));

  let body = '# Backlog\n\n';
  body += 'Planned but not yet active items.\n\n';

  if (backlog.length === 0) {
    body += '_No backlog items._\n';
  } else {
    body += TABLE_HEADER + '\n';
    for (const rec of backlog) {
      body += tableRow(rec) + '\n';
    }
  }

  body += '\n';
  return body;
}

/** Build archive.md body — closed / completed items. */
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

  let body = '# Archive\n\n';
  body += 'Closed and completed items.\n\n';

  if (archived.length === 0) {
    body += '_No archived items._\n';
  } else {
    body += TABLE_HEADER + '\n';
    for (const rec of archived) {
      body += tableRow(rec) + '\n';
    }
  }

  body += '\n';
  return body;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

/**
 * Generate all standard non-canonical wiki views.
 *
 * Writes 5 files under wiki/ in the target directory, each with a
 * `_generated: true` frontmatter marker. When the planning layer is active it
 * then writes the dashboard pages under wiki/dashboard/generated/.
 */
export async function generate(
  opts: GenerateOpts,
): Promise<Result<GenerateResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');
  debug(`generate: target=${targetDir}`);

  // 1. Layer gate. Ask before writing anything; a corrupt stamp returns its failure.
  const planning = planningInstalled(targetDir);
  if (!planning.ok) return fail(planning.error, planning.message, planning.detail);

  // 2. Load manifest
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  // 3. Collect all manifest-driven records
  const records = collectRecords(targetDir, wikiDir, manifest);
  const workTrackingRecords = records.filter(r => r.prefix !== 'PLN');
  debug(`generate: collected ${records.length} records`);

  const prefixes = planning.data ? resolvePrefixes(manifest) : null;
  if (planning.data && prefixes === null) {
    return fail('MANIFEST_ERROR', 'Manifest does not name a work item and an initiative type');
  }

  // 4. Build and write each view
  const views: Array<{
    filename: string;
    title: string;
    builder: (recs: RecordEntry[]) => string;
    includePlans?: boolean;
  }> = [
    { filename: 'catalog.md', title: 'Catalog', builder: buildCatalog, includePlans: true },
    { filename: 'now.md', title: 'Now', builder: buildNow },
    { filename: 'inbox.md', title: 'Inbox', builder: buildInbox },
    { filename: 'backlog.md', title: 'Backlog', builder: buildBacklog },
    { filename: 'archive.md', title: 'Archive', builder: buildArchive },
  ];

  const generated: string[] = [];

  // Ensure wiki directory exists
  if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true });
  }

  for (const view of views) {
    const newBody = view.builder(view.includePlans ? records : workTrackingRecords);
    const filePath = path.join(wikiDir, view.filename);

    // Reuse the existing updated: timestamp if the body is unchanged (WK-0031).
    // parseFrontmatter returns everything after the closing "---" fence, which
    // includes the separator newline(s) prepended by generatedFrontmatter, so
    // compare existing.body against the separator + newBody.
    const FRONTMATTER_SEP = '\n\n';
    const existing = readExistingView(filePath);
    const updated =
      existing !== null && existing.body === FRONTMATTER_SEP + newBody
        ? existing.updated
        : new Date().toISOString();

    const content = generatedFrontmatter(view.title, updated) + newBody;

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

  // 5. Dashboard pages, only while the planning layer is active.
  if (planning.data && prefixes) {
    const repoNameResult = repoDisplayName(targetDir);
    if (!repoNameResult.ok) {
      return fail(repoNameResult.error, repoNameResult.message, repoNameResult.detail);
    }

    // A missing chain.md is empty data with no problem; any other read error
    // (a directory, a permission failure) stops the run before any page is
    // written or any stale page is deleted.
    const chainPath = path.join(targetDir, 'wiki', 'dashboard', 'chain.md');
    let chainText: string | undefined;
    try {
      chainText = fs.readFileSync(chainPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fail(
          'GENERATE_ERROR',
          `Failed to read wiki/dashboard/chain.md: ${String(err)}`,
          err,
        );
      }
      chainText = undefined;
    }

    const dashboard = generateDashboard({
      targetDir,
      records: toDashboardRecords(records),
      workItemPrefix: prefixes.workItemPrefix,
      initiativePrefix: prefixes.initiativePrefix,
      repoName: repoNameResult.data,
      chainText,
    });
    if (!dashboard.ok) return fail(dashboard.error, dashboard.message, dashboard.detail);
    return ok({ generated, dashboard: dashboard.data });
  }

  return ok({ generated });
}
