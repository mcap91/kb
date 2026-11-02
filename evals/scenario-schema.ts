/**
 * Scenario/suite schema and loader (WK-0237 slice B1a). Shared shape with
 * slice B2's `evals/scenarios/<suite>/` content; HO-0144 extends HO-0132's
 * schema with a nullable `install_command` and the full seven check-kind
 * vocabulary (WK-0237 scope item 15.5/Resolutions 4, 7, 8 plus the
 * no-denied-tool / no-kb-wiki-call kinds this slice adds).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { z } from 'zod';

import { fail, ok, type EvalResult } from './result.js';

export const CHECK_KINDS = [
  'read-wk',
  'read-in-resume',
  'wiki-search-before-reply',
  'no-write-outside-wiki',
  'wiki-edit-only-resolutions',
  'no-denied-tool',
  'no-kb-wiki-call',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

const installCommandSchema = z
  .object({
    name: z.string(),
    git_ref: z.string(),
    path: z.string(),
  })
  .nullable();

const installSkillSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const conditionSchema = z.object({
  name: z.string(),
  install_command: installCommandSchema,
  install_skills: z.array(installSkillSchema),
});

export const suiteSchema = z.object({
  schema_version: z.literal(1),
  suite: z.string(),
  baseline_sha: z.string(),
  agents_block: z.object({ kb_commit: z.string(), words: z.number() }),
  model: z.string(),
  budget_usd: z.number(),
  timeout_sec: z.number(),
  mcp: z.string(),
  repeats: z.number(),
  gated_condition: z.string().nullable(),
  conditions: z.array(conditionSchema),
});
export type Suite = z.infer<typeof suiteSchema>;

export const scenarioSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  prompt: z.string(),
  target_wk: z.string(),
  seeded_in: z.string().nullable(),
  planted_question: z.string().min(1),
  class: z.enum(['resolvable', 'operator-only']),
  permitted_outcome: z.string(),
  checks: z.array(z.enum(CHECK_KINDS)).min(1),
  pass_threshold: z.object({ passes: z.number(), of: z.number() }),
});
export type Scenario = z.infer<typeof scenarioSchema>;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJsonFile(path: string): EvalResult<unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return fail('FILE_READ_FAILED', `failed to read ${path}: ${describeError(err)}`);
  }
  try {
    return ok(JSON.parse(raw));
  } catch (err) {
    return fail('FILE_PARSE_FAILED', `failed to parse ${path} as JSON: ${describeError(err)}`);
  }
}

/** Loads and validates `<suiteDir>/suite.json` against `suiteSchema`. */
export function loadSuite(suiteDir: string): EvalResult<Suite> {
  const raw = readJsonFile(join(suiteDir, 'suite.json'));
  if (!raw.ok) return raw;
  const parsed = suiteSchema.safeParse(raw.data);
  if (!parsed.success) {
    return fail('SUITE_SCHEMA_INVALID', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return ok(parsed.data);
}

/** Loads and validates `<scenarioDir>/scenario.json` against `scenarioSchema`. */
export function loadScenario(scenarioDir: string): EvalResult<Scenario> {
  const raw = readJsonFile(join(scenarioDir, 'scenario.json'));
  if (!raw.ok) return raw;
  const parsed = scenarioSchema.safeParse(raw.data);
  if (!parsed.success) {
    return fail(
      'SCENARIO_SCHEMA_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return ok(parsed.data);
}

/** Loads every `<suiteDir>/<scenario>/scenario.json`, skipping `suite.json` itself. */
export function loadSuiteScenarios(suiteDir: string): EvalResult<Scenario[]> {
  let entries: string[];
  try {
    entries = readdirSync(suiteDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    return fail('SUITE_DIR_READ_FAILED', `failed to read ${suiteDir}: ${describeError(err)}`);
  }

  const scenarios: Scenario[] = [];
  for (const name of entries) {
    const scenarioDir = join(suiteDir, name);
    if (!existsSync(join(scenarioDir, 'scenario.json'))) continue;
    const loaded = loadScenario(scenarioDir);
    if (!loaded.ok) return loaded;
    scenarios.push(loaded.data);
  }
  return ok(scenarios);
}

function listRecordFilesRecursive(baseRealDir: string, dir: string, prefix: string, out: string[]): EvalResult<void> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    return fail('RECORDS_READ_FAILED', `failed to read ${dir}: ${describeError(err)}`);
  }

  for (const name of entries) {
    const full = join(dir, name);
    let real: string;
    try {
      real = realpathSync(full);
    } catch (err) {
      return fail('RECORDS_READ_FAILED', `failed to resolve ${full}: ${describeError(err)}`);
    }

    const rel = relative(baseRealDir, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return fail(
        'RECORDS_PATH_ESCAPE',
        `records path escapes its directory: ${join(prefix, name)} resolves to ${real}, outside ${baseRealDir}`,
      );
    }

    const entryPath = prefix.length === 0 ? name : join(prefix, name);
    if (statSync(full).isDirectory()) {
      const sub = listRecordFilesRecursive(baseRealDir, full, entryPath, out);
      if (!sub.ok) return sub;
    } else {
      out.push(entryPath.split(sep).join('/'));
    }
  }
  return ok(undefined);
}

/**
 * Every file under `recordsDir`, as paths relative to it (POSIX separators),
 * sorted. Refuses if any entry's realpath (symlink or not) resolves outside
 * `recordsDir`'s own realpath. A missing `recordsDir` is not an error — a
 * scenario with no seeded records returns `ok([])`.
 */
export function listRecordFiles(recordsDir: string): EvalResult<string[]> {
  if (!existsSync(recordsDir)) return ok([]);
  let baseReal: string;
  try {
    baseReal = realpathSync(recordsDir);
  } catch (err) {
    return fail('RECORDS_READ_FAILED', `failed to resolve ${recordsDir}: ${describeError(err)}`);
  }

  const out: string[] = [];
  const result = listRecordFilesRecursive(baseReal, recordsDir, '', out);
  if (!result.ok) return result;
  out.sort();
  return ok(out);
}
