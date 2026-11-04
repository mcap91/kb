/**
 * `init-planning` — add or remove the planning layer entry in the committed
 * `wiki/.wiki-contract.json` (WK-0261 Resolutions rows 2, 8, 11).
 *
 * Idempotent and order-free: re-running with the same state reports no change
 * and writes nothing. Every other field in the stamp file is preserved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  InitPlanningOpts,
  InitPlanningResult,
  WikiContractMetadata,
} from './types.js';
import { debug } from './debug.js';

/** Write via a temp file in the same directory, then rename into place. */
function writeAtomic(filePath: string, content: string): void {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // The temp file may not have been created; the original error is the cause.
    }
    throw err;
  }
}

/**
 * Add (`remove` absent/false) or remove (`remove: true`) `"planning"` in the
 * `layers` array of `wiki/.wiki-contract.json`.
 *
 * Refuses with `NOT_BOOTSTRAPPED` when the stamp file is absent, matching sync.
 * Never throws.
 */
export function initPlanning(opts: InitPlanningOpts): Result<InitPlanningResult> {
  const targetDir = path.resolve(opts.dir);
  const contractPath = path.join(targetDir, 'wiki', '.wiki-contract.json');

  if (!fs.existsSync(contractPath)) {
    return fail(
      'NOT_BOOTSTRAPPED',
      `Target does not appear to be bootstrapped — missing ${contractPath}`,
    );
  }

  let meta: WikiContractMetadata;
  try {
    meta = JSON.parse(fs.readFileSync(contractPath, 'utf-8')) as WikiContractMetadata;
  } catch (err) {
    return fail(
      'PARSE_ERROR',
      `Failed to parse ${contractPath}: ${String(err)}`,
      err,
    );
  }

  const current: Array<'planning'> = Array.isArray(meta.layers) ? [...meta.layers] : [];
  const hasPlanning = current.includes('planning');
  const remove = opts.remove ?? false;
  const changed = remove ? hasPlanning : !hasPlanning;

  if (changed) {
    meta.layers = remove
      ? current.filter(layer => layer !== 'planning')
      : [...current, 'planning'];

    try {
      writeAtomic(contractPath, JSON.stringify(meta, null, 2) + '\n');
    } catch (err) {
      return fail(
        'FILE_WRITE_ERROR',
        `Failed to write ${contractPath}: ${String(err)}`,
        err,
      );
    }
    debug(`init-planning: layers=${JSON.stringify(meta.layers)}`);
  } else {
    debug('init-planning: no change');
  }

  return ok({
    layers: meta.layers ?? [],
    changed,
    path: contractPath,
  });
}
