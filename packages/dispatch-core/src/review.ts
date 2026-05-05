import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, stat, mkdir } from 'node:fs/promises';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { handoffFrontmatterSchema, agentRegistrySchema } from './schemas.js';
import type {
  HandoffFrontmatter,
  AgentRegistry,
  TokenPayload,
  ReviewOpts,
  ReviewResult,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { getConfigDir, getReviewDir } from './paths.js';
import { createToken, writeTokenFile } from './token.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_FILE = 'launchers.v1.json';

/** Default token expiry: 24 hours from now. */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Default maximum handoff file size in bytes (1 MB). */
const DEFAULT_MAX_HANDOFF_BYTES = 1024 * 1024;

/** Forbidden frontmatter fields. */
const FORBIDDEN_FIELDS = [
  '_path',
  '_paths',
  '_dir',
  '_dirs',
  'outputs',
  'command',
  'cwd',
  'model',
  'permissions',
] as const;

// ---------------------------------------------------------------------------
// YAML frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from a markdown file.
 *
 * Expects the file to start with `---\n` and contain a closing `---\n`.
 * Returns the parsed frontmatter object and the body after the closing `---`.
 */
function parseFrontmatter(content: string): DispatchResult<{ frontmatter: Record<string, unknown>; body: string }> {
  const trimmed = content.replace(/^﻿/, ''); // strip BOM if present
  if (!trimmed.startsWith('---')) {
    return fail('PARSE_ERROR', 'Handoff file must start with YAML frontmatter (---).');
  }

  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return fail('PARSE_ERROR', 'Could not find closing --- for YAML frontmatter.');
  }

  const yamlBlock = trimmed.slice(4, endIndex); // skip opening "---\n"
  const body = trimmed.slice(endIndex + 4); // skip closing "\n---"

  try {
    const parsed = parseSimpleYaml(yamlBlock);
    return ok({ frontmatter: parsed, body });
  } catch (err) {
    return fail('PARSE_ERROR', 'Failed to parse YAML frontmatter.', err);
  }
}

/**
 * Minimal YAML parser for handoff frontmatter.
 *
 * Supports: string values, numeric values, arrays (flow `[a, b]` and block `- item`),
 * and boolean-like values. Does NOT support nested objects.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // Block array continuation: "  - value"
    if (/^\s+-\s+/.test(line) && currentKey !== null) {
      const value = line.replace(/^\s+-\s+/, '').trim();
      if (currentArray === null) {
        currentArray = [];
      }
      currentArray.push(stripQuotes(value));
      result[currentKey] = currentArray;
      continue;
    }

    // Flush any pending array
    if (currentArray !== null) {
      currentArray = null;
    }

    // Key-value pair
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)/);
    if (!match) continue;

    const key = match[1]!;
    let value = match[2]!.trim();
    currentKey = key;

    if (value === '' || value === '~' || value === 'null') {
      // Might be a block array starting next line, or just null
      result[key] = null;
      currentArray = [];
      result[key] = currentArray;
      continue;
    }

    // Flow array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      const items = inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      result[key] = items;
      currentArray = null;
      continue;
    }

    // Numeric
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      result[key] = Number(value);
      currentArray = null;
      continue;
    }

    // Boolean
    if (value === 'true') {
      result[key] = true;
      currentArray = null;
      continue;
    }
    if (value === 'false') {
      result[key] = false;
      currentArray = null;
      continue;
    }

    // String (strip quotes if present)
    result[key] = stripQuotes(value);
    currentArray = null;
  }

  return result;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Read First section parsing
// ---------------------------------------------------------------------------

interface ReadFirstResult {
  paths: string[];
  warnings: string[];
}

/**
 * Parse the `Read First` section from the handoff body.
 *
 * Rules:
 * - Extract bare relative-path bullets
 * - Reject absolute paths
 * - Reject markdown links
 */
function parseReadFirst(body: string): DispatchResult<ReadFirstResult> {
  // Find the "Read First" section (## Read First or # Read First)
  const sectionMatch = body.match(/^#{1,3}\s+Read\s+First\s*$/m);
  if (!sectionMatch) {
    return ok({ paths: [], warnings: [] });
  }

  const sectionStart = sectionMatch.index! + sectionMatch[0].length;
  // Find the next heading to delimit the section
  const nextHeading = body.slice(sectionStart).match(/^#{1,3}\s+/m);
  const sectionEnd = nextHeading
    ? sectionStart + nextHeading.index!
    : body.length;
  const section = body.slice(sectionStart, sectionEnd);

  const paths: string[] = [];
  const warnings: string[] = [];
  const lines = section.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and non-bullet lines
    if (!line.startsWith('-') && !line.startsWith('*')) continue;

    const bullet = line.replace(/^[-*]\s*/, '').trim();
    if (bullet === '') continue;

    // Reject markdown links
    if (/\[.*\]\(.*\)/.test(bullet)) {
      return fail(
        'INVALID_HANDOFF',
        `Read First contains a markdown link: ${bullet}. Only bare relative paths are allowed.`,
      );
    }

    // Reject absolute paths
    if (isAbsolute(bullet) || /^[A-Za-z]:[\\/]/.test(bullet)) {
      return fail(
        'INVALID_HANDOFF',
        `Read First contains an absolute path: ${bullet}. Only relative paths are allowed.`,
      );
    }

    // Reject paths with .. traversal
    const normalized = normalize(bullet);
    if (normalized.startsWith('..')) {
      return fail(
        'INVALID_HANDOFF',
        `Read First path escapes repo root: ${bullet}.`,
      );
    }

    paths.push(bullet);
  }

  return ok({ paths, warnings });
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hashBuffer(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute a combined hash of all files in the review bundle manifest.
 */
function computeManifestHash(entries: { path: string; hash: string }[]): string {
  // Sort by path for determinism, then hash the concatenated "path:hash" strings
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const combined = sorted.map((e) => `${e.path}:${e.hash}`).join('\n');
  return hashBuffer(combined);
}

// ---------------------------------------------------------------------------
// Registry loading
// ---------------------------------------------------------------------------

async function loadRegistry(): Promise<DispatchResult<{ registry: AgentRegistry; hash: string; raw: string }>> {
  const registryPath = join(getConfigDir(), REGISTRY_FILE);
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch {
    return fail(
      'REGISTRY_NOT_FOUND',
      `Agent registry not found at ${registryPath}. Run init-config first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('PARSE_ERROR', `Failed to parse agent registry at ${registryPath}.`);
  }

  const result = agentRegistrySchema.safeParse(parsed);
  if (!result.success) {
    return fail('PARSE_ERROR', `Invalid agent registry format.`, result.error);
  }

  return ok({ registry: result.data as AgentRegistry, hash: hashBuffer(raw), raw });
}

// ---------------------------------------------------------------------------
// Review implementation
// ---------------------------------------------------------------------------

/**
 * Review a handoff document and create an immutable review bundle.
 *
 * This is the core review operation that validates a handoff, creates a
 * review bundle in `.agent-runs/reviews/RV-<uuid>/`, and issues a signed
 * pending token for launch.
 */
export async function review(opts: ReviewOpts): Promise<DispatchResult<ReviewResult>> {
  const repoRoot = resolve(opts.dir);
  const handoffRelative = opts.handoff;
  const handoffPath = join(repoRoot, handoffRelative);

  // -----------------------------------------------------------------------
  // 1. Check that the handoff file exists and enforce size limit
  // -----------------------------------------------------------------------
  let handoffStat;
  try {
    handoffStat = await stat(handoffPath);
  } catch {
    return fail('FILE_NOT_FOUND', `Handoff file not found: ${handoffPath}`);
  }

  if (handoffStat.size > DEFAULT_MAX_HANDOFF_BYTES) {
    return fail(
      'INVALID_HANDOFF',
      `Handoff file exceeds size limit (${handoffStat.size} bytes > ${DEFAULT_MAX_HANDOFF_BYTES} bytes).`,
    );
  }

  // -----------------------------------------------------------------------
  // 2. Read and parse frontmatter
  // -----------------------------------------------------------------------
  let content: string;
  try {
    content = await readFile(handoffPath, 'utf-8');
  } catch {
    return fail('FILE_NOT_FOUND', `Cannot read handoff file: ${handoffPath}`);
  }

  const parseResult = parseFrontmatter(content);
  if (!parseResult.ok) return parseResult;

  const { frontmatter: rawFrontmatter, body } = parseResult.data;

  // -----------------------------------------------------------------------
  // 3. Reject forbidden fields
  // -----------------------------------------------------------------------
  for (const field of FORBIDDEN_FIELDS) {
    if (field in rawFrontmatter) {
      return fail(
        'FORBIDDEN_FIELD',
        `Handoff contains forbidden field: ${field}`,
      );
    }
  }

  // Also reject any key ending with _path, _paths, _dir, _dirs
  for (const key of Object.keys(rawFrontmatter)) {
    if (
      key.endsWith('_path') ||
      key.endsWith('_paths') ||
      key.endsWith('_dir') ||
      key.endsWith('_dirs')
    ) {
      return fail(
        'FORBIDDEN_FIELD',
        `Handoff contains forbidden path-bearing field: ${key}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 4. Validate required fields via Zod schema
  // -----------------------------------------------------------------------
  const validation = handoffFrontmatterSchema.safeParse(rawFrontmatter);
  if (!validation.success) {
    return fail(
      'MISSING_FIELD',
      `Handoff frontmatter validation failed.`,
      validation.error,
    );
  }

  const frontmatter = validation.data as HandoffFrontmatter;

  // -----------------------------------------------------------------------
  // 5. Enforce allowed_agents
  // -----------------------------------------------------------------------
  if (!frontmatter.allowed_agents.includes(opts.agent)) {
    return fail(
      'AGENT_NOT_ALLOWED',
      `Agent "${opts.agent}" is not in the handoff's allowed_agents list: [${frontmatter.allowed_agents.join(', ')}].`,
    );
  }

  // -----------------------------------------------------------------------
  // 6. Parse Read First section
  // -----------------------------------------------------------------------
  const readFirstResult = parseReadFirst(body);
  if (!readFirstResult.ok) return readFirstResult;

  const { paths: readFirstPaths, warnings } = readFirstResult.data;

  // Validate that all referenced paths exist
  for (const relPath of readFirstPaths) {
    const absPath = join(repoRoot, relPath);
    try {
      await stat(absPath);
    } catch {
      return fail(
        'FILE_NOT_FOUND',
        `Read First references a file that does not exist: ${relPath}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 7. Load and verify registry
  // -----------------------------------------------------------------------
  const registryResult = await loadRegistry();
  if (!registryResult.ok) return registryResult;

  const { registry, hash: registryHash } = registryResult.data;

  // Verify agent exists in registry
  if (!(opts.agent in registry.agents)) {
    return fail(
      'INVALID_AGENT',
      `Agent "${opts.agent}" is not configured in the registry.`,
    );
  }

  // -----------------------------------------------------------------------
  // 8. Build immutable review bundle
  // -----------------------------------------------------------------------
  const reviewId = `RV-${randomUUID()}`;
  const bundlePath = getReviewDir(repoRoot, reviewId);
  await mkdir(bundlePath, { recursive: true });

  // Track manifest entries for hashing
  const manifestEntries: { path: string; hash: string }[] = [];

  // Copy the handoff file
  const bundledHandoffName = handoffRelative.replace(/[\\/]/g, '__');
  const bundledHandoffPath = join(bundlePath, bundledHandoffName);
  await copyFile(handoffPath, bundledHandoffPath);
  manifestEntries.push({
    path: bundledHandoffName,
    hash: hashBuffer(content),
  });

  // Copy Read First referenced files
  for (const relPath of readFirstPaths) {
    const srcPath = join(repoRoot, relPath);
    const destName = relPath.replace(/[\\/]/g, '__');
    const destPath = join(bundlePath, destName);
    const fileContent = await readFile(srcPath);
    await copyFile(srcPath, destPath);
    manifestEntries.push({
      path: destName,
      hash: hashBuffer(fileContent),
    });
  }

  // Write review manifest
  const manifest = {
    reviewId,
    handoffId: frontmatter.id,
    agent: opts.agent,
    mode: frontmatter.mode,
    handoffPath: handoffRelative,
    readFirstPaths,
    timestamp: new Date().toISOString(),
    files: manifestEntries,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  await writeFile(join(bundlePath, 'review-manifest.json'), manifestJson);

  // -----------------------------------------------------------------------
  // 9. Compute input manifest hash
  // -----------------------------------------------------------------------
  const inputManifestHash = computeManifestHash(manifestEntries);

  // -----------------------------------------------------------------------
  // 10. Create pending token
  // -----------------------------------------------------------------------
  const expiry = new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();

  const payload: TokenPayload = {
    reviewId,
    handoffId: frontmatter.id,
    agent: opts.agent,
    mode: frontmatter.mode,
    repoRoot,
    inputManifestHash,
    registryHash,
    expiry,
  };

  const tokenResult = await createToken(payload);
  if (!tokenResult.ok) return tokenResult;

  const tokenPath = await writeTokenFile(tokenResult.data, 'pending');

  // -----------------------------------------------------------------------
  // 11. Return review result
  // -----------------------------------------------------------------------
  const result: ReviewResult = {
    reviewId,
    handoffId: frontmatter.id,
    agent: opts.agent,
    mode: frontmatter.mode,
    bundlePath,
    tokenPath,
    expiry,
  };

  return ok(result);
}
