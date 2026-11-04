/**
 * Bootstrap a consuming repo's wiki directory.
 *
 * Creates the standard directory structure, writes metadata files,
 * copies bootstrap surfaces and record templates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  BootstrapOpts,
  BootstrapResult,
  WikiContractMetadata,
  IdState,
  WikiManifest,
} from './types.js';
import {
  loadManifest,
  getBootstrapTemplates,
  getRecordTemplates,
  getSkillSources,
  SKILL_RUNTIME_DIRS,
  getAgentInstructionsSections,
  type AgentInstructionsSection,
} from './contract.js';
import {
  writeManagedBlock,
  assembleBlockBody,
  checkBlockBudget,
  dispatchInstalled,
  planningInstalled,
} from './agent-instructions.js';
import { writeMcpConfig } from './mcp-config.js';
import { ensureGitignoreEntries } from './gitignore.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bootstrap surface files — these are only written if absent.
 * Map of destination (relative to wiki/) to source filename in contract/bootstrap/.
 */
const BOOTSTRAP_SURFACES: Record<string, string> = {
  'schema.md': 'schema.md',
  'conventions.md': 'conventions.md',
  'index.md': 'index.md',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists, creating it recursively if needed. */
function ensureDir(dirPath: string, dryRun: boolean, created: string[]): void {
  if (!fs.existsSync(dirPath)) {
    if (!dryRun) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    created.push(dirPath);
    debug(`created directory: ${dirPath}`);
  }
}

/** Write a file only if it does not already exist. Returns true if written. */
function writeIfAbsent(
  filePath: string,
  content: string | Buffer,
  dryRun: boolean,
  created: string[],
  skipped: string[],
): boolean {
  if (fs.existsSync(filePath)) {
    skipped.push(filePath);
    debug(`skipped (exists): ${filePath}`);
    return false;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  created.push(filePath);
  debug(`wrote: ${filePath}`);
  return true;
}

function initialIdState(manifest: WikiManifest): IdState {
  const idState: IdState = {};
  for (const [, typeDef] of Object.entries(manifest.types)) {
    if (typeDef.prefix && typeDef.stateKey) {
      idState[typeDef.prefix] = { next: 1, allocated: [] };
    }
  }
  return idState;
}

function mergeMissingIdStateEntries(current: IdState, manifestState: IdState): boolean {
  let changed = false;
  for (const [prefix, initial] of Object.entries(manifestState)) {
    if (!current[prefix]) {
      current[prefix] = initial;
      changed = true;
    }
  }
  return changed;
}

/**
 * Scan wiki directories for existing {PREFIX}-{NNNN}.md files.
 * Returns a map of prefix → sorted list of numeric IDs found on disk.
 */
function scanExistingEntries(
  targetDir: string,
  manifest: WikiManifest,
): Record<string, number[]> {
  const found: Record<string, number[]> = {};

  for (const typeDef of Object.values(manifest.types)) {
    if (typeDef.idStrategy !== 'allocated' || !typeDef.prefix) continue;

    const prefix = typeDef.prefix;
    const dir = path.join(targetDir, typeDef.directory);

    if (!fs.existsSync(dir)) continue;

    const pattern = new RegExp(`^${prefix}-(\\d{4})\\.md$`);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    const numbers: number[] = [];
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (match) {
        numbers.push(parseInt(match[1], 10));
      }
    }

    if (numbers.length > 0) {
      found[prefix] = numbers.sort((a, b) => a - b);
    }
  }

  return found;
}

/**
 * Reconcile ID state with entries found on disk.
 * Bumps `next` to max(on-disk) + 1 if stale, adds missing numbers to `allocated`.
 */
function reconcileIdState(state: IdState, diskEntries: Record<string, number[]>): boolean {
  let anyChanged = false;

  for (const [prefix, numbers] of Object.entries(diskEntries)) {
    if (!state[prefix]) {
      state[prefix] = { next: 1, allocated: [] };
    }

    const entry = state[prefix];
    const maxOnDisk = Math.max(...numbers);
    let prefixChanged = false;

    if (entry.next <= maxOnDisk) {
      entry.next = maxOnDisk + 1;
      prefixChanged = true;
    }

    const allocSet = new Set(entry.allocated);
    for (const num of numbers) {
      if (!allocSet.has(num)) {
        entry.allocated.push(num);
        prefixChanged = true;
      }
    }

    if (prefixChanged) {
      entry.allocated.sort((a, b) => a - b);
      anyChanged = true;
    }
  }

  return anyChanged;
}

function ensureContractMetadata(
  filePath: string,
  metadata: WikiContractMetadata,
  dryRun: boolean,
  created: string[],
  skipped: string[],
): Result<void> {
  if (fs.existsSync(filePath)) {
    skipped.push(filePath);
    debug(`skipped metadata (exists): ${filePath}`);
    return ok(undefined);
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
  }
  created.push(filePath);
  debug(`wrote metadata: ${filePath}`);
  return ok(undefined);
}

function ensureIdState(
  filePath: string,
  manifestState: IdState,
  targetDir: string,
  manifest: WikiManifest,
  dryRun: boolean,
  created: string[],
  skipped: string[],
): Result<void> {
  const diskEntries = scanExistingEntries(targetDir, manifest);

  if (!fs.existsSync(filePath)) {
    const state: IdState = JSON.parse(JSON.stringify(manifestState)) as IdState;
    reconcileIdState(state, diskEntries);

    if (!dryRun) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    }
    created.push(filePath);
    debug(`wrote id state: ${filePath}`);
    return ok(undefined);
  }

  let current: IdState;
  try {
    current = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IdState;
  } catch (err) {
    return fail('PARSE_ERROR', `Failed to read existing ID state: ${String(err)}`, err);
  }

  const merged = mergeMissingIdStateEntries(current, manifestState);
  const reconciled = reconcileIdState(current, diskEntries);

  if (!merged && !reconciled) {
    skipped.push(filePath);
    debug(`skipped id state (current): ${filePath}`);
    return ok(undefined);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  }
  created.push(filePath);
  debug(`reconciled id state: ${filePath}`);
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstrap a consuming repo's wiki directory structure.
 *
 * - Creates standard directories (including wiki/handoffs/)
 * - Writes wiki/.wiki-contract.json and wiki/.id-state.json
 * - Copies bootstrap surfaces (schema.md, conventions.md, index.md) only if absent
 * - Copies record templates (including handoff.md)
 * - Copies skill files (contract/skills/<name>/) into .claude/skills/<name>/ and
 *   .agents/skills/<name>/, only if absent
 * - Preserves existing docs/, AGENTS.md, CLAUDE.md
 * - Supports --dry-run
 */
export async function bootstrap(
  opts: BootstrapOpts,
): Promise<Result<BootstrapResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');
  const dryRun = opts.dryRun ?? false;

  debug(`bootstrap target: ${targetDir}`);
  debug(`dry-run: ${dryRun}`);

  // Load manifest to get contract version
  const manifestResult = loadManifest();
  if (!manifestResult.ok) {
    return fail('CONTRACT_NOT_FOUND', manifestResult.message);
  }
  const manifest = manifestResult.data;

  // Refuse before any write when the managed block would exceed the budget (WK-0229 ruling 16).
  const agentInstructions = opts.agentInstructions ?? true;
  let agentInstructionsSections: AgentInstructionsSection[] | undefined;
  if (agentInstructions) {
    const sectionsResult = getAgentInstructionsSections();
    if (!sectionsResult.ok) return sectionsResult;
    const budgetResult = checkBlockBudget(sectionsResult.data);
    if (!budgetResult.ok) return budgetResult;
    agentInstructionsSections = sectionsResult.data;
  }

  const created: string[] = [];
  const skipped: string[] = [];

  // Refuse before any write when the stamp exists but cannot be parsed (WK-0261 fix-up).
  const planningResult = planningInstalled(targetDir);
  if (!planningResult.ok) return planningResult;
  const planning = planningResult.data;

  // 1. Create wiki directories
  for (const rel of manifest.requiredSurfaces) {
    const abs = path.join(targetDir, rel);
    ensureDir(abs, dryRun, created);
  }

  // 2. Create metadata files or safely merge missing ID state entries.
  const contractMeta: WikiContractMetadata = {
    contractVersion: manifest.contractVersion,
    repo: opts.repo,
    bootstrappedAt: new Date().toISOString(),
  };
  const metadataResult = ensureContractMetadata(
    path.join(wikiDir, '.wiki-contract.json'),
    contractMeta,
    dryRun,
    created,
    skipped,
  );
  if (!metadataResult.ok) return metadataResult;

  const idStateResult = ensureIdState(
    path.join(wikiDir, '.id-state.json'),
    initialIdState(manifest),
    targetDir,
    manifest,
    dryRun,
    created,
    skipped,
  );
  if (!idStateResult.ok) return idStateResult;

  // 3. Copy bootstrap surfaces (only if absent)
  const bootstrapResult = getBootstrapTemplates();
  if (bootstrapResult.ok) {
    for (const [destName, srcName] of Object.entries(BOOTSTRAP_SURFACES)) {
      const srcPath = bootstrapResult.data.find(p => path.basename(p) === srcName);
      if (srcPath) {
        const destPath = path.join(wikiDir, destName);
        const content = fs.readFileSync(srcPath, 'utf-8');
        writeIfAbsent(destPath, content, dryRun, created, skipped);
      }
    }
  }

  // 4. Copy record templates (including handoff.md)
  const templatesResult = getRecordTemplates();
  if (templatesResult.ok) {
    // Determine template target directory
    const templateDest = path.join(wikiDir, 'templates');
    ensureDir(templateDest, dryRun, created);

    for (const srcPath of templatesResult.data) {
      const filename = path.basename(srcPath);
      const destPath = path.join(templateDest, filename);
      const content = fs.readFileSync(srcPath, 'utf-8');
      writeIfAbsent(destPath, content, dryRun, created, skipped);
    }
  }

  // 5. Copy skill files from contract/skills/<name>/ into .claude/skills/<name>/ and
  // .agents/skills/<name>/ (write-if-absent, templates pattern — never gated on
  // wiki/.dispatch/ or agentInstructions).
  const skillsResult = getSkillSources();
  if (skillsResult.ok) {
    for (const file of skillsResult.data) {
      const content = fs.readFileSync(file.srcPath);
      for (const runtimeDir of SKILL_RUNTIME_DIRS) {
        const destPath = path.join(targetDir, runtimeDir, file.skill, file.relPath);
        writeIfAbsent(destPath, content, dryRun, created, skipped);
      }
    }
  }

  // 6. Write agent instructions managed block
  const updated: string[] = [];
  const instructions: string[] = [];

  const dispatch = dispatchInstalled(targetDir);

  if (agentInstructionsSections) {
    const blockBody = assembleBlockBody(agentInstructionsSections, { planning, dispatch });
    const blockResult = writeManagedBlock(targetDir, blockBody, { dryRun });
    if (blockResult.ok) {
      for (const entry of blockResult.data) {
        if (entry.action !== 'unchanged') {
          updated.push(entry.file);
        }
      }
    }
  }

  // 7. Write .mcp.json
  const mcpClient = opts.mcpClient ?? 'claude';
  const mcpResult = writeMcpConfig(targetDir, { client: mcpClient, dispatch, dryRun });
  if (mcpResult.ok) {
    const mcpData = mcpResult.data;
    if (mcpData.action === 'created' || mcpData.action === 'updated') {
      updated.push('.mcp.json');
      instructions.push('Merged kb servers into .mcp.json');
    } else if (mcpData.action === 'unchanged') {
      instructions.push('.mcp.json already up to date');
    }
    if (mcpData.commands) {
      instructions.push(...mcpData.commands);
    }
  }

  // 8. Ensure .gitignore contains kb entries
  const gitignoreResult = ensureGitignoreEntries(targetDir, { dryRun });
  if (gitignoreResult.action !== 'unchanged') {
    updated.push('.gitignore');
  }

  // Normalize paths to use forward slashes for consistency
  const normalize = (p: string): string => path.relative(targetDir, p).replace(/\\/g, '/');

  return ok({
    created: created.map(normalize),
    skipped: skipped.map(normalize),
    updated,
    instructions: instructions.length > 0 ? instructions : undefined,
  });
}
