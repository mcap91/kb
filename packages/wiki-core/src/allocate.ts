/**
 * ID allocation module.
 *
 * Allocates sequential IDs for manifest-driven wiki record types.
 * Validates prefix against contract/manifest.json, rejects unknown prefixes.
 * Uses atomic write (write-to-temp-then-rename) for concurrency safety.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ok, fail, type Result } from './errors.js';
import type { AllocateOpts, AllocateResult, IdState, ManifestRecordType } from './types.js';
import { loadManifest } from './contract.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Zero-pad a number to 4 digits. */
function padId(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Find the manifest record type definition that matches a given prefix.
 * Returns undefined if no matching type is found.
 */
function findTypeByPrefix(
  types: Record<string, ManifestRecordType>,
  prefix: string,
): ManifestRecordType | undefined {
  for (const typeDef of Object.values(types)) {
    if (typeDef.prefix === prefix) {
      return typeDef;
    }
  }
  return undefined;
}

/**
 * Scan a record directory for the highest `${prefix}-NNNN.md` id present on disk.
 * Returns 0 if the directory does not exist or no matching file is found.
 */
function findMaxIdOnDisk(recordDir: string, prefix: string): number {
  if (!fs.existsSync(recordDir)) return 0;
  const re = new RegExp(`^${prefix}-(\\d+)\\.md$`);
  let max = 0;
  for (const filename of fs.readdirSync(recordDir)) {
    const match = re.exec(filename);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Allocate
// ---------------------------------------------------------------------------

/**
 * Allocate the next sequential ID for a given prefix.
 *
 * - Validates the prefix against the manifest (rejects unknown prefixes)
 * - Reads wiki/.id-state.json
 * - Increments the `next` counter and appends to `allocated`
 * - Writes the state atomically (write-to-temp-then-rename)
 * - Returns the allocated ID string (e.g. "WK-0001")
 */
export async function allocate(
  opts: AllocateOpts,
): Promise<Result<AllocateResult>> {
  if (opts.verbose) setVerbose(true);

  const prefix = opts.prefix;

  debug(`allocate: prefix=${prefix}, dir=${opts.dir}`);

  // 1. Load manifest and validate prefix
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  // Check excluded prefixes
  if (manifest.excludedPrefixes.includes(prefix)) {
    return fail(
      'INVALID_PREFIX',
      `Prefix "${prefix}" is excluded from wiki record creation`,
    );
  }

  // Find the type definition for this prefix
  const typeDef = findTypeByPrefix(manifest.types, prefix);
  if (!typeDef) {
    return fail(
      'INVALID_PREFIX',
      `Prefix "${prefix}" is not defined in the manifest`,
    );
  }

  // Only allocated ID strategy types can use this function
  if (typeDef.idStrategy !== 'allocated') {
    return fail(
      'INVALID_PREFIX',
      `Prefix "${prefix}" uses "${typeDef.idStrategy}" ID strategy, not sequential allocation`,
    );
  }

  // 2. Read current ID state
  const targetDir = path.resolve(opts.dir);
  const idStatePath = path.join(targetDir, 'wiki', '.id-state.json');

  if (!fs.existsSync(idStatePath)) {
    return fail(
      'NOT_BOOTSTRAPPED',
      `ID state file not found at ${idStatePath} — run bootstrap first`,
    );
  }

  let idState: IdState;
  try {
    const raw = fs.readFileSync(idStatePath, 'utf-8');
    idState = JSON.parse(raw) as IdState;
  } catch (err) {
    return fail(
      'ALLOCATION_FAILED',
      `Failed to read ID state: ${String(err)}`,
      err,
    );
  }

  // Ensure this prefix has an entry in the state
  if (!idState[prefix]) {
    idState[prefix] = { next: 1, allocated: [] };
  }

  const entry = idState[prefix];
  const recordDir = path.join(targetDir, typeDef.directory);

  // 3. Reconcile state against disk (WK-0178).
  //
  // .id-state.json can lag reality: the live incident that motivated this guard was a
  // hand-authored record (SRC-0012.md) committed directly to disk without ever going
  // through allocate()/create(), so its number was never reflected in `next`. The next
  // allocate() then handed out the same number again and create() silently overwrote the
  // existing file. Heal forward instead of trusting the counter blindly: `next` can never
  // be lower than one past the highest id actually present on disk for this prefix. This
  // only ever moves `next` up — gaps left by deleted mid-records are never reclaimed.
  const maxOnDisk = findMaxIdOnDisk(recordDir, prefix);
  let stateChanged = false;
  if (maxOnDisk + 1 > entry.next) {
    entry.next = maxOnDisk + 1;
    stateChanged = true;
  }

  // 4. Allocate the next ID.
  //
  // Allocation is idempotent until a record file claims the ID. A bare allocate
  // (a "peek"/reserve that writes no record) advances `next` exactly once, leaving
  // a single fileless slot at `next - 1`. Subsequent allocations reuse that slot
  // instead of advancing again, so repeated peeks and the eventual create() collapse
  // onto the same number rather than burning orphaned IDs. We only reclaim the
  // contiguous tail slot (`next - 1`); gaps left by deleted mid-records are never
  // refilled, so existing references are never resurrected.
  const reservedNumber = entry.next - 1;
  const reservedIsFileless =
    reservedNumber >= 1 &&
    !fs.existsSync(path.join(recordDir, `${prefix}-${padId(reservedNumber)}.md`));

  let number: number;
  if (reservedIsFileless) {
    // Reuse the prior reservation. Reconciliation above guarantees this slot is not the
    // one it just bumped `next` past (that slot is always file-backed by construction), so
    // reusing it here can never resurrect a stale/colliding id.
    number = reservedNumber;
  } else {
    number = entry.next;
    entry.next = number + 1;
    if (!entry.allocated.includes(number)) entry.allocated.push(number);
    stateChanged = true;
  }

  // 5. Write state atomically (write-to-temp-then-rename) whenever it changed —
  // either from reconciliation or from advancing `next` for a fresh allocation.
  if (stateChanged) {
    const tmpPath = idStatePath + `.tmp-${crypto.randomBytes(4).toString('hex')}`;
    try {
      const content = JSON.stringify(idState, null, 2) + '\n';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, idStatePath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch { /* ignore cleanup errors */ }
      return fail(
        'ALLOCATION_FAILED',
        `Failed to write ID state atomically: ${String(err)}`,
        err,
      );
    }
  }

  // 6. Return the allocated ID
  const id = `${prefix}-${padId(number)}`;
  debug(`allocated: ${id}`);

  return ok({ id, number });
}
