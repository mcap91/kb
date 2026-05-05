import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { TokenPayload, DispatchToken } from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getConfigDir, getTokenDir, type TokenState } from './paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_FILE = 'token.key';
const KEY_BYTES = 32; // 256-bit HMAC key
const ALGORITHM = 'sha256';

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * Generate an HMAC key and write it to `token.key` in the config directory.
 *
 * Returns the path to the key file.
 */
export async function generateKey(): Promise<string> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  const keyPath = join(configDir, KEY_FILE);
  const key = randomBytes(KEY_BYTES);
  await writeFile(keyPath, key);
  return keyPath;
}

/**
 * Read the HMAC key from `token.key` in the config directory.
 */
export async function loadKey(): Promise<DispatchResult<Buffer>> {
  const keyPath = join(getConfigDir(), KEY_FILE);
  try {
    const key = await readFile(keyPath);
    return ok(key);
  } catch {
    return fail(
      'CONFIG_NOT_FOUND',
      `HMAC key not found at ${keyPath}. Run init-config first.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

function sign(payload: TokenPayload, key: Buffer): string {
  const data = JSON.stringify(payload);
  return createHmac(ALGORITHM, key).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Token operations
// ---------------------------------------------------------------------------

/**
 * Create a signed `DispatchToken` from a `TokenPayload`.
 *
 * Uses HMAC-SHA256 over the JSON-serialized payload.
 */
export async function createToken(
  payload: TokenPayload,
): Promise<DispatchResult<DispatchToken>> {
  const keyResult = await loadKey();
  if (!keyResult.ok) return keyResult;

  const signature = sign(payload, keyResult.data);
  const token: DispatchToken = {
    payload,
    signature,
    createdAt: new Date().toISOString(),
  };
  return ok(token);
}

/**
 * Verify a token's signature and check its expiry.
 *
 * Returns `ok(payload)` when the token is valid and not expired.
 */
export async function verifyToken(
  token: DispatchToken,
): Promise<DispatchResult<TokenPayload>> {
  const keyResult = await loadKey();
  if (!keyResult.ok) return keyResult;

  const expected = sign(token.payload, keyResult.data);
  if (expected !== token.signature) {
    return fail('TOKEN_INVALID', 'Token signature verification failed.');
  }

  const expiry = new Date(token.payload.expiry);
  if (expiry.getTime() <= Date.now()) {
    return fail('TOKEN_EXPIRED', `Token expired at ${token.payload.expiry}.`);
  }

  return ok(token.payload);
}

/**
 * Write a token to a state directory as a JSON file.
 *
 * The file is named `<reviewId>.json`.
 */
export async function writeTokenFile(
  token: DispatchToken,
  state: TokenState,
): Promise<string> {
  const dir = getTokenDir(state);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${token.payload.reviewId}.json`);
  await writeFile(filePath, JSON.stringify(token, null, 2));
  return filePath;
}

/**
 * Read a token from a state directory.
 */
export async function readTokenFile(
  reviewId: string,
  state: TokenState,
): Promise<DispatchResult<DispatchToken>> {
  const filePath = join(getTokenDir(state), `${reviewId}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const token = JSON.parse(raw) as DispatchToken;
    return ok(token);
  } catch {
    return fail(
      'TOKEN_NOT_FOUND',
      `Token ${reviewId} not found in ${state}/ directory.`,
    );
  }
}

/**
 * Move a token file between state directories.
 *
 * For example: pending -> launching -> consumed, or pending -> rejected.
 */
export async function moveToken(
  reviewId: string,
  fromState: TokenState,
  toState: TokenState,
): Promise<DispatchResult<string>> {
  const fromPath = join(getTokenDir(fromState), `${reviewId}.json`);
  const toDir = getTokenDir(toState);
  await mkdir(toDir, { recursive: true });
  const toPath = join(toDir, `${reviewId}.json`);

  try {
    await rename(fromPath, toPath);
    return ok(toPath);
  } catch (err) {
    return fail(
      'TOKEN_NOT_FOUND',
      `Failed to move token ${reviewId} from ${fromState}/ to ${toState}/.`,
      err,
    );
  }
}
