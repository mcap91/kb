/**
 * Import upstream planning artifacts into a PLN-* companion bundle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  ImportPlanOpts,
  ImportPlanResult,
  PlanBundleManifest,
} from './types.js';
import { debug, setVerbose } from './debug.js';
import {
  getPlanBundleDir,
  getPlanBundleRelPath,
  getPlanDesignPath,
  getPlanDesignRelPath,
  getPlanExecutionPath,
  getPlanExecutionRelPath,
  getPlanRecordPath,
  readPlanBundleManifest,
  writePlanBundleManifest,
} from './plan-bundle.js';

interface MarkdownRecord {
  frontmatter: Record<string, unknown>;
  body: string;
}

function resolveInputPath(targetDir: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(targetDir, inputPath);
}

function repoRel(targetDir: string, absPath: string): string {
  return path.relative(targetDir, absPath).replace(/\\/g, '/');
}

function toBundleRel(bundleDir: string, absPath: string): string {
  return path.relative(bundleDir, absPath).replace(/\\/g, '/');
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

function writeMarkdownRecord(absPath: string, record: MarkdownRecord): Result<void> {
  try {
    fs.writeFileSync(
      absPath,
      `${stringifyFrontmatter(record.frontmatter)}${record.body}`,
      'utf-8',
    );
    return ok(undefined);
  } catch (err) {
    return fail(
      'FILE_WRITE_ERROR',
      `Failed to write plan record: ${String(err)}`,
      err,
    );
  }
}

function assertFile(absPath: string, label: string): Result<void> {
  if (!fs.existsSync(absPath)) {
    return fail('FILE_NOT_FOUND', `${label} not found: ${absPath}`);
  }
  const stats = fs.statSync(absPath);
  if (!stats.isFile()) {
    return fail('INVALID_FIELD', `${label} must be a file: ${absPath}`);
  }
  return ok(undefined);
}

function assertWritableTarget(destPath: string, overwrite: boolean): Result<void> {
  if (fs.existsSync(destPath) && !overwrite) {
    return fail(
      'IMPORT_ERROR',
      `Refusing to overwrite ${destPath}; pass overwrite to replace bundle-owned files`,
    );
  }
  return ok(undefined);
}

function copyFileChecked(srcPath: string, destPath: string, overwrite: boolean): Result<void> {
  const writable = assertWritableTarget(destPath, overwrite);
  if (!writable.ok) return writable;

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    return ok(undefined);
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to copy file: ${String(err)}`, err);
  }
}

function copyDirectoryContents(srcDir: string, destDir: string, overwrite: boolean): Result<void> {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        const copied = copyDirectoryContents(srcPath, destPath, overwrite);
        if (!copied.ok) return copied;
        continue;
      }

      if (entry.isFile()) {
        const copied = copyFileChecked(srcPath, destPath, overwrite);
        if (!copied.ok) return copied;
      }
    }
    return ok(undefined);
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to copy directory: ${String(err)}`, err);
  }
}

function copyRawFile(
  bundleDir: string,
  label: string,
  srcPath: string,
  overwrite: boolean,
): Result<string> {
  const destPath = path.join(bundleDir, 'source', 'raw', `${label}-${path.basename(srcPath)}`);
  const copied = copyFileChecked(srcPath, destPath, overwrite);
  if (!copied.ok) return copied;
  return ok(toBundleRel(bundleDir, destPath));
}

function copyRawDirectory(
  bundleDir: string,
  label: string,
  srcDir: string,
  overwrite: boolean,
): Result<string[]> {
  const rawRoot = path.join(bundleDir, 'source', 'raw', label, path.basename(srcDir));
  const copied = copyDirectoryContents(srcDir, rawRoot, overwrite);
  if (!copied.ok) return copied;

  const artifacts: string[] = [];
  function collect(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(absPath);
      } else if (entry.isFile()) {
        artifacts.push(toBundleRel(bundleDir, absPath));
      }
    }
  }

  collect(rawRoot);
  artifacts.sort();
  return ok(artifacts);
}

function readPlanRecord(recordPath: string): Result<MarkdownRecord> {
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

function updatePlanRecord(
  recordPath: string,
  planId: string,
  timestamp: string,
  sourceTool: string | undefined,
): Result<void> {
  const recordResult = readPlanRecord(recordPath);
  if (!recordResult.ok) return recordResult;

  const record = recordResult.data;
  if (record.frontmatter['id'] !== planId) {
    return fail(
      'INVALID_FIELD',
      `Plan record id must be "${planId}" before import`,
    );
  }

  const currentStatus = record.frontmatter['status'];
  const preserveStatuses = new Set(['active', 'done', 'archived']);
  if (typeof currentStatus !== 'string' || !preserveStatuses.has(currentStatus)) {
    record.frontmatter['status'] = 'packaged';
  }

  if (sourceTool) {
    record.frontmatter['source_tool'] = sourceTool;
  }
  record.frontmatter['bundle_path'] = getPlanBundleRelPath(planId);
  record.frontmatter['design_entry'] = getPlanDesignRelPath(planId);
  record.frontmatter['execution_entry'] = getPlanExecutionRelPath(planId);
  record.frontmatter['updated'] = timestamp;

  return writeMarkdownRecord(recordPath, record);
}

export async function importPlan(
  opts: ImportPlanOpts,
): Promise<Result<ImportPlanResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const planId = opts.plan;
  const overwrite = opts.overwrite ?? false;
  const timestamp = new Date().toISOString();

  debug(`importPlan: plan=${planId}, dir=${targetDir}`);

  const recordPath = getPlanRecordPath(targetDir, planId);
  const bundleDir = getPlanBundleDir(targetDir, planId);
  const designSource = resolveInputPath(targetDir, opts.design);

  const designFile = assertFile(designSource, 'Design source');
  if (!designFile.ok) return designFile;
  if (path.extname(designSource).toLowerCase() !== '.md') {
    return fail('INVALID_FIELD', `Design source must be a markdown file: ${repoRel(targetDir, designSource)}`);
  }

  const manifestResult = readPlanBundleManifest(targetDir, planId);
  if (!manifestResult.ok) return manifestResult;

  const canonicalDesign = getPlanDesignPath(targetDir, planId);
  const copiedDesign = copyFileChecked(designSource, canonicalDesign, overwrite);
  if (!copiedDesign.ok) return copiedDesign;

  const sourceArtifacts: string[] = [];
  const rawDesign = copyRawFile(bundleDir, 'design', designSource, overwrite);
  if (!rawDesign.ok) return rawDesign;
  sourceArtifacts.push(rawDesign.data);

  if (opts.execution) {
    const executionSource = resolveInputPath(targetDir, opts.execution);
    if (!fs.existsSync(executionSource)) {
      return fail('FILE_NOT_FOUND', `Execution source not found: ${executionSource}`);
    }

    const stats = fs.statSync(executionSource);
    if (stats.isFile()) {
      const copiedExecution = copyFileChecked(
        executionSource,
        getPlanExecutionPath(targetDir, planId),
        overwrite,
      );
      if (!copiedExecution.ok) return copiedExecution;

      const rawExecution = copyRawFile(bundleDir, 'execution', executionSource, overwrite);
      if (!rawExecution.ok) return rawExecution;
      sourceArtifacts.push(rawExecution.data);
    } else if (stats.isDirectory()) {
      if (!fs.existsSync(path.join(executionSource, 'tracker.md'))) {
        return fail(
          'IMPORT_ERROR',
          `Execution directory import must provide tracker.md: ${repoRel(targetDir, executionSource)}`,
        );
      }

      const executionDir = path.dirname(getPlanExecutionPath(targetDir, planId));
      const copiedExecutionDir = copyDirectoryContents(executionSource, executionDir, overwrite);
      if (!copiedExecutionDir.ok) return copiedExecutionDir;

      const rawExecutionDir = copyRawDirectory(bundleDir, 'execution', executionSource, overwrite);
      if (!rawExecutionDir.ok) return rawExecutionDir;
      sourceArtifacts.push(...rawExecutionDir.data);
    } else {
      return fail('INVALID_FIELD', `Execution source must be a file or directory: ${executionSource}`);
    }
  }

  const manifest: PlanBundleManifest = {
    ...manifestResult.data,
    updated_at: timestamp,
    producer: {
      ...manifestResult.data.producer,
      tool: opts.sourceTool || manifestResult.data.producer.tool || 'manual',
    },
    entrypoints: {
      design: 'design/spec.md',
      execution: 'execution/tracker.md',
    },
    source_artifacts: sourceArtifacts,
  };

  const wroteManifest = writePlanBundleManifest(targetDir, planId, manifest);
  if (!wroteManifest.ok) return wroteManifest;

  const updatedRecord = updatePlanRecord(recordPath, planId, timestamp, opts.sourceTool);
  if (!updatedRecord.ok) return updatedRecord;

  return ok({
    plan: planId,
    bundlePath: getPlanBundleRelPath(planId),
    designEntry: getPlanDesignRelPath(planId),
    executionEntry: getPlanExecutionRelPath(planId),
    sourceArtifacts,
  });
}
