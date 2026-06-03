/**
 * Explicit PLN-* record and companion bundle validation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, type Result } from './errors.js';
import type {
  PlanBundleManifest,
  ValidatePlanIssue,
  ValidatePlanOpts,
  ValidatePlanResult,
} from './types.js';
import { debug, setVerbose } from './debug.js';
import { planBundleManifestSchema } from './schemas.js';
import {
  getPlanBundleDir,
  getPlanBundleManifestPath,
  getPlanBundleRelPath,
  getPlanRecordPath,
  isPathInsidePlanBundle,
  readPlanBundleManifest,
} from './plan-bundle.js';

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  const trimmed = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(4, endIdx);
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
      data[key] = inner === ''
        ? undefined
        : inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    if (typeof value === 'string') {
      value = value.replace(/^["']|["']$/g, '');
    }

    if (value === 'true') value = true;
    else if (value === 'false') value = false;

    data[key] = value;
  }

  if (currentKey && currentArray !== null) {
    data[currentKey] = currentArray.length > 0 ? currentArray : undefined;
  }

  return data;
}

function repoRel(targetDir: string, absPath: string): string {
  return path.relative(targetDir, absPath).replace(/\\/g, '/');
}

function resolveRepoPath(targetDir: string, relPath: string): string {
  return path.resolve(targetDir, relPath.replace(/\//g, path.sep));
}

function addIssue(
  issues: ValidatePlanIssue[],
  code: string,
  message: string,
  issuePath?: string,
): void {
  issues.push({ code, message, ...(issuePath ? { path: issuePath } : {}) });
}

function getStringField(fm: Record<string, unknown>, field: string): string | undefined {
  const value = fm[field];
  return typeof value === 'string' && value ? value : undefined;
}

function validateEntrypoint(
  targetDir: string,
  planId: string,
  fm: Record<string, unknown>,
  field: 'design_entry' | 'execution_entry',
  issues: ValidatePlanIssue[],
): void {
  const value = getStringField(fm, field);
  if (!value) {
    addIssue(issues, 'MISSING_FIELD', `Plan field "${field}" is missing or empty`, field);
    return;
  }

  if (!isPathInsidePlanBundle(targetDir, planId, value)) {
    addIssue(
      issues,
      'PATH_OUTSIDE_BUNDLE',
      `Plan field "${field}" must stay inside wiki/plans/${planId}/`,
      value,
    );
    return;
  }

  const absPath = resolveRepoPath(targetDir, value);
  if (!fs.existsSync(absPath)) {
    addIssue(issues, 'FILE_NOT_FOUND', `Referenced plan file does not exist: ${value}`, value);
  }
}

function validateSourceArtifacts(
  targetDir: string,
  planId: string,
  manifest: PlanBundleManifest,
  issues: ValidatePlanIssue[],
): void {
  const bundleDir = getPlanBundleDir(targetDir, planId);

  for (const sourcePath of manifest.source_artifacts) {
    if (!sourcePath.startsWith('source/raw/')) {
      addIssue(
        issues,
        'PATH_OUTSIDE_SOURCE_RAW',
        'Bundle source_artifacts entries must stay under source/raw/',
        sourcePath,
      );
      continue;
    }

    const absPath = path.resolve(bundleDir, sourcePath.replace(/\//g, path.sep));
    const relToBundle = path.relative(bundleDir, absPath);
    if (relToBundle.startsWith('..') || path.isAbsolute(relToBundle)) {
      addIssue(
        issues,
        'PATH_OUTSIDE_BUNDLE',
        `Bundle source artifact escapes wiki/plans/${planId}/`,
        sourcePath,
      );
      continue;
    }

    if (!fs.existsSync(absPath)) {
      addIssue(
        issues,
        'FILE_NOT_FOUND',
        `Referenced source artifact does not exist: ${sourcePath}`,
        sourcePath,
      );
    }
  }
}

export async function validatePlan(
  opts: ValidatePlanOpts,
): Promise<Result<ValidatePlanResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const planId = opts.plan;
  const issues: ValidatePlanIssue[] = [];

  debug(`validatePlan: plan=${planId}, dir=${targetDir}`);

  const recordPath = getPlanRecordPath(targetDir, planId);
  const recordRelPath = repoRel(targetDir, recordPath);

  if (!fs.existsSync(recordPath)) {
    addIssue(issues, 'FILE_NOT_FOUND', `Plan record not found: ${recordRelPath}`, recordRelPath);
    return ok({ plan: planId, valid: false, issues });
  }

  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, 'utf-8');
  } catch (err) {
    addIssue(
      issues,
      'FILE_NOT_FOUND',
      `Failed to read plan record: ${String(err)}`,
      recordRelPath,
    );
    return ok({ plan: planId, valid: false, issues });
  }

  const fm = parseFrontmatter(raw);
  if (!fm) {
    addIssue(issues, 'PARSE_ERROR', `Plan record has invalid frontmatter: ${recordRelPath}`, recordRelPath);
    return ok({ plan: planId, valid: false, issues });
  }

  const recordId = getStringField(fm, 'id');
  if (recordId !== planId) {
    addIssue(
      issues,
      'ID_MISMATCH',
      `Plan record id must be "${planId}" but found "${recordId ?? ''}"`,
      recordRelPath,
    );
  }

  const expectedBundlePath = getPlanBundleRelPath(planId);
  const bundlePath = getStringField(fm, 'bundle_path');
  if (bundlePath !== expectedBundlePath) {
    addIssue(
      issues,
      'INVALID_BUNDLE_PATH',
      `Plan bundle_path must equal "${expectedBundlePath}"`,
      bundlePath || 'bundle_path',
    );
  }

  validateEntrypoint(targetDir, planId, fm, 'design_entry', issues);
  validateEntrypoint(targetDir, planId, fm, 'execution_entry', issues);

  const manifestPath = getPlanBundleManifestPath(targetDir, planId);
  const manifestRelPath = repoRel(targetDir, manifestPath);
  const manifestResult = readPlanBundleManifest(targetDir, planId);
  if (!manifestResult.ok) {
    addIssue(issues, manifestResult.error, manifestResult.message, manifestRelPath);
    return ok({ plan: planId, valid: false, issues });
  }

  const parsedManifest = planBundleManifestSchema.safeParse(manifestResult.data);
  if (!parsedManifest.success) {
    for (const issue of parsedManifest.error.issues) {
      addIssue(
        issues,
        'SCHEMA_VALIDATION',
        issue.message,
        `bundle.json:${issue.path.join('.')}`,
      );
    }
    return ok({ plan: planId, valid: false, issues });
  }

  const manifest = parsedManifest.data;
  if (manifest.plan_id !== planId) {
    addIssue(
      issues,
      'PLAN_ID_MISMATCH',
      `Bundle manifest plan_id must be "${planId}" but found "${manifest.plan_id}"`,
      manifestRelPath,
    );
  }

  validateSourceArtifacts(targetDir, planId, manifest, issues);

  return ok({
    plan: planId,
    valid: issues.length === 0,
    issues,
  });
}
