import * as fs from 'node:fs';
import * as path from 'node:path';
import { fail, ok, type Result } from '../errors.js';
import { readChainDoc } from './chain-doc.js';
import { buildPages } from './pages.js';
import type { DashboardRecord, DashboardSummary } from './types.js';

export const DASHBOARD_DIR = 'wiki/dashboard/generated';

export interface GenerateDashboardOpts {
  targetDir: string;
  records: DashboardRecord[];
  workItemPrefix: string;
  initiativePrefix: string;
  repoName: string;
  /** The `chain.md` text, or `undefined` when the file is absent. */
  chainText?: string;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    // Only a missing path is "not here"; every other lstat failure (EACCES,
    // ENOTDIR, ELOOP) reaches the caller so the real cause is reported.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function ensureRealDir(target: string, rel: string): Result<null> {
  let stat: fs.Stats | null;
  try {
    stat = lstatOrNull(target);
  } catch (err) {
    return fail('GENERATE_ERROR', `Failed to inspect ${rel}: ${String(err)}`, err);
  }
  if (stat) {
    if (stat.isDirectory()) return ok(null);
    return fail('GENERATE_ERROR', `${rel} exists and is not a real directory`);
  }
  try {
    fs.mkdirSync(target);
    return ok(null);
  } catch (err) {
    return fail('GENERATE_ERROR', `Failed to create ${rel}: ${String(err)}`, err);
  }
}

/**
 * Create every parent directory of a page below the owned folder. A symbolic
 * link on the path is removed as a link, never followed out of the folder.
 */
function ensurePageDir(generatedDir: string, rel: string): void {
  const parts = rel.split('/').filter(Boolean);
  let current = generatedDir;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    const stat = lstatOrNull(current);
    if (stat === null) {
      fs.mkdirSync(current);
    } else if (stat.isSymbolicLink()) {
      fs.unlinkSync(current);
      fs.mkdirSync(current);
    } else if (!stat.isDirectory()) {
      throw new Error(`${current} is not a directory`);
    }
  }
}

/** Write one page in place; a symbolic link at the target is removed first. */
function writePage(generatedDir: string, rel: string, content: string): void {
  if (rel.includes('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing page path outside the owned folder: ${rel}`);
  }
  ensurePageDir(generatedDir, rel);
  const target = path.join(generatedDir, ...rel.split('/'));
  const stat = lstatOrNull(target);
  if (stat && stat.isSymbolicLink()) fs.unlinkSync(target);
  fs.writeFileSync(target, content, 'utf-8');
}

/** Remove every file this run did not write, and every directory left empty. */
function cleanup(generatedDir: string, written: Set<string>): void {
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const target = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(target);
        continue;
      }
      if (stat.isDirectory()) {
        walk(target, rel);
        if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
        continue;
      }
      if (!written.has(rel)) fs.unlinkSync(target);
    }
  };
  walk(generatedDir, '');
}

/**
 * Write the dashboard pages into the owned folder and remove stale files.
 *
 * Returns the folder (repo-relative) and the page count. A `wiki/dashboard` or
 * `wiki/dashboard/generated` that is not a real directory fails with
 * `GENERATE_ERROR` before anything is written.
 */
export function generateDashboard(opts: GenerateDashboardOpts): Result<DashboardSummary> {
  const dashboardDir = path.join(opts.targetDir, 'wiki', 'dashboard');
  const generatedDir = path.join(dashboardDir, 'generated');

  const dashboardDirResult = ensureRealDir(dashboardDir, 'wiki/dashboard');
  if (!dashboardDirResult.ok) return dashboardDirResult;
  const generatedDirResult = ensureRealDir(generatedDir, DASHBOARD_DIR);
  if (!generatedDirResult.ok) return generatedDirResult;

  const chainExists = opts.chainText !== undefined;
  const { data: chain } = readChainDoc(opts.chainText, {
    workPrefix: opts.workItemPrefix,
    initiativePrefix: opts.initiativePrefix,
    workItemIds: new Set(
      opts.records.filter(r => r.prefix === opts.workItemPrefix).map(r => r.id),
    ),
    initiativeIds: new Set(
      opts.records.filter(r => r.prefix === opts.initiativePrefix).map(r => r.id),
    ),
  });

  const pages = buildPages({
    targetDir: opts.targetDir,
    records: opts.records,
    workItemPrefix: opts.workItemPrefix,
    initiativePrefix: opts.initiativePrefix,
    repoName: opts.repoName,
    chain,
    chainExists,
  });

  const written = new Set<string>();
  const sorted = [...pages.keys()].sort();
  for (const rel of sorted) {
    try {
      writePage(generatedDir, rel, pages.get(rel) as string);
      written.add(rel);
    } catch (err) {
      return fail('GENERATE_ERROR', `Failed to write ${DASHBOARD_DIR}/${rel}: ${String(err)}`, err);
    }
  }

  try {
    cleanup(generatedDir, written);
  } catch (err) {
    return fail('GENERATE_ERROR', `Failed to clean ${DASHBOARD_DIR}: ${String(err)}`, err);
  }

  return ok({ dir: DASHBOARD_DIR, pages: pages.size });
}
