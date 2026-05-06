import { readFile, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

import { handoffFrontmatterSchema } from './schemas.js';
import type { HandoffFrontmatter } from './types.js';
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';

export const DEFAULT_LIMITS = {
  maxHandoffBytes: 131072,
  maxLinkedFileBytes: 524288,
  maxTotalReviewedBytes: 2097152,
  maxLinkedFiles: 20,
};

const REQUIRED_FRONTMATTER_FIELDS = [
  'schema_version',
  'id',
  'title',
  'subject',
  'allowed_agents',
  'mode',
] as const;

const FORBIDDEN_FRONTMATTER_FIELDS = new Set([
  'outputs',
  'command',
  'cwd',
  'model',
  'permissions',
]);

const FORBIDDEN_PATH_FIELD_PATTERNS = [
  /(?:^|_)path(?:s)?$/i,
  /(?:^|_)dir(?:s)?$/i,
  /(?:^|_)(?:response|wrapper|handoff|context|repo)_path$/i,
  /(?:^|_)(?:response|wrapper|handoff|context|repo)_dir$/i,
];

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let pendingEmptyKey: string | null = null;

  const flushPendingEmptyKey = (): void => {
    if (pendingEmptyKey !== null) {
      result[pendingEmptyKey] = '';
      pendingEmptyKey = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    if (/^\s+-\s+/.test(line) && (pendingEmptyKey !== null || currentKey !== null)) {
      if (pendingEmptyKey !== null) {
        currentKey = pendingEmptyKey;
        currentArray = [];
        result[currentKey] = currentArray;
        pendingEmptyKey = null;
      }

      const value = line.replace(/^\s+-\s+/, '').trim();
      if (currentArray === null) {
        currentArray = [];
      }
      currentArray.push(stripQuotes(value));
      if (currentKey !== null) {
        result[currentKey] = currentArray;
      }
      continue;
    }

    flushPendingEmptyKey();
    if (currentArray !== null) {
      currentArray = null;
    }

    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)/);
    if (!match) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }

    const key = match[1]!;
    const rawValue = match[2]!.trim();
    currentKey = key;

    if (rawValue === '') {
      pendingEmptyKey = key;
      continue;
    }

    if (rawValue === '~' || rawValue === 'null') {
      result[key] = null;
      pendingEmptyKey = null;
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((part) => stripQuotes(part.trim()))
        .filter(Boolean);
      continue;
    }

    if (/^-?\d+$/.test(rawValue)) {
      result[key] = Number.parseInt(rawValue, 10);
      continue;
    }

    result[key] = stripQuotes(rawValue);
  }

  flushPendingEmptyKey();
  return result;
}

function parseFrontmatter(content: string): DispatchResult<{ frontmatter: Record<string, unknown>; body: string }> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return fail('PARSE_ERROR', 'Handoff file must begin with YAML frontmatter.');
  }

  try {
    const [, frontmatterText, body] = match;
    return ok({
      frontmatter: parseSimpleYaml(frontmatterText),
      body,
    });
  } catch (err) {
    return fail('PARSE_ERROR', 'Failed to parse handoff frontmatter.', err);
  }
}

function extractReadFirst(body: string): DispatchResult<string[]> {
  const lines = body.split('\n');
  const results: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === '## Read First';
      continue;
    }

    if (!inSection) {
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    if (!line.startsWith('- ')) {
      return fail('INVALID_HANDOFF', 'Read First section may contain only bare bullet paths.');
    }

    const value = line.slice(2).trim();
    if (!value) {
      continue;
    }

    if (value.includes('[') || value.includes(']') || value.includes('(') || value.includes(')')) {
      return fail('INVALID_HANDOFF', 'Read First section does not allow markdown links.');
    }

    if (isAbsolute(value)) {
      return fail('INVALID_HANDOFF', 'Read First paths must be relative.');
    }

    const normalized = normalize(value);
    if (normalized.startsWith('..')) {
      return fail('INVALID_HANDOFF', `Read First path escapes repo root: ${value}`);
    }

    results.push(value);
  }

  return ok(results);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function canonicalizePath(path: string): Promise<string> {
  return realpath(path);
}

export function assertPathInside(repoRoot: string, targetPath: string, message: string): DispatchResult<true> {
  const hint = relative(repoRoot, targetPath);
  if (hint === '' || (!hint.startsWith('..') && !isAbsolute(hint))) {
    return ok(true);
  }
  return fail('INVALID_HANDOFF', message);
}

export async function loadHandoff(
  handoffPath: string,
  limits = DEFAULT_LIMITS,
): Promise<DispatchResult<{
  content: string;
  frontmatter: HandoffFrontmatter;
  body: string;
  readFirst: string[];
}>> {
  let content: string;
  let handoffStats;

  try {
    content = await readFile(handoffPath, 'utf8');
    handoffStats = await stat(handoffPath);
  } catch {
    return fail('FILE_NOT_FOUND', `Handoff file not found: ${handoffPath}`);
  }

  if (handoffStats.size > limits.maxHandoffBytes) {
    return fail('INVALID_HANDOFF', `Handoff exceeds max size of ${limits.maxHandoffBytes} bytes.`);
  }

  const frontmatterResult = parseFrontmatter(content);
  if (!frontmatterResult.ok) return frontmatterResult;

  const { frontmatter: rawFrontmatter, body } = frontmatterResult.data;

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!(field in rawFrontmatter)) {
      return fail('MISSING_FIELD', `Missing required handoff field: ${field}`);
    }
  }

  for (const key of Object.keys(rawFrontmatter)) {
    if (FORBIDDEN_FRONTMATTER_FIELDS.has(key)) {
      return fail('FORBIDDEN_FIELD', `Forbidden handoff field: ${key}`);
    }

    if (FORBIDDEN_PATH_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      return fail('FORBIDDEN_FIELD', `Forbidden handoff path field: ${key}`);
    }
  }

  const validation = handoffFrontmatterSchema.safeParse(rawFrontmatter);
  if (!validation.success) {
    return fail('PARSE_ERROR', 'Handoff frontmatter validation failed.', validation.error);
  }

  const parsed = validation.data as HandoffFrontmatter;
  if (!/^HO-\d{4}$/.test(String(parsed.id))) {
    return fail('INVALID_HANDOFF', 'Handoff id must match ^HO-[0-9]{4}$.');
  }

  if (!Array.isArray(parsed.allowed_agents) || parsed.allowed_agents.length === 0) {
    return fail('INVALID_HANDOFF', 'allowed_agents must be a non-empty array.');
  }

  const readFirstResult = extractReadFirst(body);
  if (!readFirstResult.ok) return readFirstResult;

  return ok({
    content,
    frontmatter: parsed,
    body,
    readFirst: readFirstResult.data,
  });
}
