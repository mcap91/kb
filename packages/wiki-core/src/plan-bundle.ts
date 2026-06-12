/**
 * Helpers for PLN-* companion bundle paths and skeleton creation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type { PlanBundleManifest } from './types.js';
import { getTemplate } from './contract.js';

function repoRel(...segments: string[]): string {
  return segments.join('/');
}

function repoAbs(targetDir: string, ...segments: string[]): string {
  return path.join(path.resolve(targetDir), ...segments);
}

function writeIfAbsent(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

export function getPlanRecordRelPath(planId: string): string {
  return repoRel('wiki', 'plans', `${planId}.md`);
}

export function getPlanBundleRelPath(planId: string): string {
  return `${repoRel('wiki', 'plans', planId)}/`;
}

export function getPlanDesignRelPath(planId: string): string {
  return repoRel('wiki', 'plans', planId, 'design', 'spec.md');
}

export function getPlanExecutionRelPath(planId: string): string {
  return repoRel('wiki', 'plans', planId, 'execution', 'tracker.md');
}

export function getPlanRecordPath(targetDir: string, planId: string): string {
  return repoAbs(targetDir, 'wiki', 'plans', `${planId}.md`);
}

export function getPlanBundleDir(targetDir: string, planId: string): string {
  return repoAbs(targetDir, 'wiki', 'plans', planId);
}

export function getPlanDesignPath(targetDir: string, planId: string): string {
  return repoAbs(targetDir, 'wiki', 'plans', planId, 'design', 'spec.md');
}

export function getPlanExecutionPath(targetDir: string, planId: string): string {
  return repoAbs(targetDir, 'wiki', 'plans', planId, 'execution', 'tracker.md');
}

export function getPlanBundleManifestPath(targetDir: string, planId: string): string {
  return repoAbs(targetDir, 'wiki', 'plans', planId, 'bundle.json');
}

export function writePlanBundleManifest(
  targetDir: string,
  planId: string,
  manifest: PlanBundleManifest,
): Result<PlanBundleManifest> {
  const manifestPath = getPlanBundleManifestPath(targetDir, planId);

  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    return ok(manifest);
  } catch (err) {
    return fail(
      'FILE_WRITE_ERROR',
      `Failed to write plan bundle manifest: ${String(err)}`,
      err,
    );
  }
}

export function readPlanBundleManifest(
  targetDir: string,
  planId: string,
): Result<PlanBundleManifest> {
  const manifestPath = getPlanBundleManifestPath(targetDir, planId);

  if (!fs.existsSync(manifestPath)) {
    return fail('FILE_NOT_FOUND', `Plan bundle manifest not found at ${manifestPath}`);
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return ok(JSON.parse(raw) as PlanBundleManifest);
  } catch (err) {
    return fail(
      'PARSE_ERROR',
      `Failed to read plan bundle manifest: ${String(err)}`,
      err,
    );
  }
}

export function ensurePlanBundleSkeleton(
  targetDir: string,
  planId: string,
  timestamp: string,
): Result<PlanBundleManifest> {
  const bundleDir = getPlanBundleDir(targetDir, planId);
  const designDir = path.join(bundleDir, 'design');
  const executionDir = path.join(bundleDir, 'execution');
  const rawSourceDir = path.join(bundleDir, 'source', 'raw');

  const manifest: PlanBundleManifest = {
    plan_id: planId,
    normalization_version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    producer: {
      tool: 'manual',
    },
    entrypoints: {
      design: 'design/spec.md',
      execution: 'execution/tracker.md',
    },
    source_artifacts: [],
  };

  try {
    fs.mkdirSync(designDir, { recursive: true });
    fs.mkdirSync(executionDir, { recursive: true });
    fs.mkdirSync(rawSourceDir, { recursive: true });
    writeIfAbsent(
      getPlanDesignPath(targetDir, planId),
      `# ${planId} Design\n\nMachine-seeded placeholder for the normalized plan design.\n`,
    );

    let trackerContent = `# ${planId} Execution Tracker\n\nMachine-seeded placeholder for the normalized execution tracker.\n`;
    const templateResult = getTemplate('plan-execution-tracker.md');
    if (templateResult.ok) {
      trackerContent = templateResult.data.replace(/\{\{id\}\}/g, planId);
    }
    writeIfAbsent(getPlanExecutionPath(targetDir, planId), trackerContent);
  } catch (err) {
    return fail(
      'FILE_WRITE_ERROR',
      `Failed to create plan bundle skeleton: ${String(err)}`,
      err,
    );
  }

  return writePlanBundleManifest(targetDir, planId, manifest);
}

export function isPathInsidePlanBundle(
  targetDir: string,
  planId: string,
  candidatePath: string,
): boolean {
  const bundleDir = path.resolve(getPlanBundleDir(targetDir, planId));
  const candidateAbs = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(targetDir, candidatePath);
  const relative = path.relative(bundleDir, candidateAbs);

  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
