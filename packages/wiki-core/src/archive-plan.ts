/**
 * Mark a PLN-* record done without moving or deleting its companion bundle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  ArchivePlanOpts,
  ArchivePlanResult,
} from './types.js';
import { debug, setVerbose } from './debug.js';
import { getPlanRecordPath } from './plan-bundle.js';

interface MarkdownRecord {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseMarkdownRecord(raw: string): MarkdownRecord | null {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(4, endIdx);
  const body = trimmed.slice(endIdx + 4);
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    if (currentKey && currentArray !== null) {
      const arrayItemMatch = line.match(/^  ?- (.*)$/);
      if (arrayItemMatch) {
        const value = arrayItemMatch[1].trim().replace(/^["']|["']$/g, '');
        if (value) currentArray.push(value);
        continue;
      }
      frontmatter[currentKey] = currentArray.length > 0 ? currentArray : undefined;
      currentArray = null;
      currentKey = null;
    }

    const kvMatch = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value: unknown = kvMatch[2].trim();

    if (value === '' || value === 'null' || value === '~') {
      currentKey = key;
      currentArray = [];
      continue;
    }

    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      frontmatter[key] = inner === ''
        ? []
        : inner.split(',').map(item => item.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    if (typeof value === 'string') {
      value = value.replace(/^["']|["']$/g, '');
    }

    if (value === 'true') value = true;
    else if (value === 'false') value = false;

    frontmatter[key] = value;
  }

  if (currentKey && currentArray !== null) {
    frontmatter[currentKey] = currentArray.length > 0 ? currentArray : undefined;
  }

  return { frontmatter, body };
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  if (value === undefined || value === null) return '';
  return JSON.stringify(String(value));
}

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
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
      continue;
    }

    yaml += `${key}: ${formatScalar(value)}\n`;
  }

  yaml += '---';
  return yaml;
}

function readMarkdownRecord(recordPath: string): Result<MarkdownRecord> {
  if (!fs.existsSync(recordPath)) {
    return fail('FILE_NOT_FOUND', `Plan record not found: ${recordPath}`);
  }

  try {
    const raw = fs.readFileSync(recordPath, 'utf-8');
    const parsed = parseMarkdownRecord(raw);
    if (!parsed) {
      return fail('PARSE_ERROR', `Plan record has invalid frontmatter: ${recordPath}`);
    }
    return ok(parsed);
  } catch (err) {
    return fail('FILE_NOT_FOUND', `Failed to read plan record: ${String(err)}`, err);
  }
}

function writeMarkdownRecord(recordPath: string, record: MarkdownRecord): Result<void> {
  try {
    fs.writeFileSync(
      recordPath,
      `${stringifyFrontmatter(record.frontmatter)}${record.body}`,
      'utf-8',
    );
    return ok(undefined);
  } catch (err) {
    return fail('ARCHIVE_ERROR', `Failed to write completed plan: ${String(err)}`, err);
  }
}

export async function archivePlan(
  opts: ArchivePlanOpts,
): Promise<Result<ArchivePlanResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const planId = opts.plan;
  const timestamp = new Date().toISOString();

  debug(`archivePlan: plan=${planId}, dir=${targetDir}`);

  if (!/^PLN-\d{4}$/.test(planId)) {
    return fail('INVALID_PREFIX', `archivePlan only supports PLN-* records: ${planId}`);
  }

  const recordPath = getPlanRecordPath(targetDir, planId);
  const recordResult = readMarkdownRecord(recordPath);
  if (!recordResult.ok) return recordResult;

  const record = recordResult.data;
  if (record.frontmatter['id'] !== planId) {
    return fail(
      'INVALID_FIELD',
      `Plan record id must be "${planId}" before completion`,
    );
  }

  record.frontmatter['status'] = 'done';
  if (!record.frontmatter['completed']) {
    record.frontmatter['completed'] = timestamp;
  }
  delete record.frontmatter['archived'];
  record.frontmatter['updated'] = timestamp;

  const writeResult = writeMarkdownRecord(recordPath, record);
  if (!writeResult.ok) return writeResult;

  return ok({
    plan: planId,
    path: path.relative(targetDir, recordPath).replace(/\\/g, '/'),
    completed: String(record.frontmatter['completed']),
  });
}
