/**
 * ID allocation module.
 *
 * Allocates sequential IDs for manifest-driven wiki record types.
 * Validates prefix against contract/manifest.json, rejects HO and unknown prefixes.
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

// ---------------------------------------------------------------------------
// Allocate
// ---------------------------------------------------------------------------

/**
 * Allocate the next sequential ID for a given prefix.
 *
 * - Validates the prefix against the manifest (rejects HO and unknown prefixes)
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

  // Check excluded prefixes (HO is explicitly excluded)
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

  // 3. Allocate the next ID
  const entry = idState[prefix];
  const number = entry.next;
  entry.next = number + 1;
  entry.allocated.push(number);

  // 4. Write state atomically (write-to-temp-then-rename)
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

  // 5. Return the allocated ID
  const id = `${prefix}-${padId(number)}`;
  debug(`allocated: ${id}`);

  return ok({ id, number });
}
