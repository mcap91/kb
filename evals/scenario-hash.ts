/**
 * Scenario directory sha256 (WK-0237 Acceptance: "a scenario directory sha256
 * function over scenario.json plus every file under records/, sorted by
 * path"). Used to pin a scenario's content so a changed hash starts a new
 * result set (WK-0237 scope 15.4).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fail, ok, type EvalResult } from './result.js';
import { listRecordFiles } from './scenario-schema.js';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * sha256 over `<scenarioDir>/scenario.json`'s bytes followed by every file
 * under `<scenarioDir>/records/`, sorted by path. Each entry is hashed as
 * `<label>\0<content>\0` so path and content boundaries cannot collide.
 */
export function hashScenarioDir(scenarioDir: string): EvalResult<string> {
  let scenarioContent: Buffer;
  try {
    scenarioContent = readFileSync(join(scenarioDir, 'scenario.json'));
  } catch (err) {
    return fail('SCENARIO_READ_FAILED', `failed to read scenario.json in ${scenarioDir}: ${describeError(err)}`);
  }

  const recordsDir = join(scenarioDir, 'records');
  const filesResult = listRecordFiles(recordsDir);
  if (!filesResult.ok) return filesResult;

  const hash = createHash('sha256');
  hash.update('scenario.json\0');
  hash.update(scenarioContent);
  hash.update('\0');

  for (const relPath of filesResult.data) {
    let content: Buffer;
    try {
      content = readFileSync(join(recordsDir, relPath));
    } catch (err) {
      return fail('RECORDS_READ_FAILED', `failed to read records/${relPath} in ${scenarioDir}: ${describeError(err)}`);
    }
    hash.update(`records/${relPath}\0`);
    hash.update(content);
    hash.update('\0');
  }

  return ok(hash.digest('hex'));
}
