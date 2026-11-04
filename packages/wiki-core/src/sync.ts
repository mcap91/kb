/**
 * Sync contract templates into an already-bootstrapped consuming repo.
 *
 * - Syncs record templates from contract/templates/ into the target repo
 * - Syncs skill files from contract/skills/<name>/ into .claude/skills/<name>/ and
 *   .agents/skills/<name>/, overwritten on drift (byte-identical)
 * - Reports drift on shared bootstrap surfaces (schema.md, conventions.md, index.md)
 * - Does NOT overwrite bootstrap surfaces — they are consumer-owned after bootstrap
 * - Updates wiki/.wiki-contract.json with lastSyncedAt timestamp
 * - Warns (never installs) when a user-global role or skill shadows the repo copy
 * - Supports --check mode (report what would change without making changes)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import type {
  SyncOpts,
  SyncResult,
  WikiContractMetadata,
  IdState,
  WikiManifest,
} from './types.js';
import {
  findKbRoot,
  loadManifest,
  getRecordTemplates,
  getSkillSources,
  SKILL_RUNTIME_DIRS,
  bootstrapDir,
  getAgentInstructionsSections,
  type AgentInstructionsSection,
} from './contract.js';
import {
  writeManagedBlock,
  assembleBlockBody,
  checkBlockBudget,
  dispatchInstalled,
} from './agent-instructions.js';
import { writeMcpConfig } from './mcp-config.js';
import { ensureGitignoreEntries } from './gitignore.js';
import { debug, setVerbose } from './debug.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bootstrap surfaces to check for drift (relative to wiki/). */
const BOOTSTRAP_SURFACES = ['schema.md', 'conventions.md', 'index.md'];

// ---------------------------------------------------------------------------
// EOL normalization
// ---------------------------------------------------------------------------

/** Strip carriage returns so CRLF vs LF differences do not trigger false drift. */
function normalizeEol(s: string): string {
  return s.replace(/\r/g, '');
}

/** Detect the dominant line ending in a string (CRLF or LF). */
function dominantEol(s: string): '\r\n' | '\n' {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(targetDir: string, absPath: string): string {
  return path.relative(targetDir, absPath).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Warn-only checks (WK-0240 stage 2 rulings 2–3, 7): user-global role drift and
// skill shadowing. These never write under $HOME and never change the Result.
// ---------------------------------------------------------------------------

/** Return true if `p` exists, checked with lstat so a (broken) symlink counts. */
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Warn when a user-global role copy (`~/.claude/commands/<file>`,
 * `~/.codex/prompts/<file>`) differs from its `contract/roles/<file>` source.
 */
function computeRoleWarnings(): string[] {
  const warnings: string[] = [];
  const rolesDir = path.join(findKbRoot(), 'contract', 'roles');

  let roleFiles: string[];
  try {
    roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.md'));
  } catch {
    return warnings;
  }

  const userGlobalDirs = [
    path.join(os.homedir(), '.claude', 'commands'),
    path.join(os.homedir(), '.codex', 'prompts'),
  ];

  for (const filename of roleFiles) {
    const contractContent = fs.readFileSync(path.join(rolesDir, filename), 'utf-8');
    for (const destDir of userGlobalDirs) {
      const destPath = path.join(destDir, filename);
      if (!fs.existsSync(destPath)) continue;
      const destContent = fs.readFileSync(destPath, 'utf-8');
      if (normalizeEol(destContent) !== normalizeEol(contractContent)) {
        warnings.push(
          `user-global role ${destPath} differs from contract/roles/${filename}; run \`install-roles\` from your kb checkout`,
        );
      }
    }
  }

  return warnings;
}

/**
 * Warn when a user-global skill of the same name shadows (Claude) or
 * duplicates (Codex) the repo-managed copy.
 */
function computeSkillWarnings(skillNames: string[]): string[] {
  const warnings: string[] = [];
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const codexSkillsDir = path.join(os.homedir(), '.agents', 'skills');

  for (const name of skillNames) {
    const claudePath = path.join(claudeSkillsDir, name);
    if (lexists(claudePath)) {
      warnings.push(
        `user-global skill ${claudePath} shadows the repo copy .claude/skills/${name}; remove it`,
      );
    }

    const codexPath = path.join(codexSkillsDir, name);
    if (lexists(codexPath)) {
      warnings.push(
        `user-global skill ${codexPath} duplicates the repo copy .agents/skills/${name} (Codex shows both in skill selectors); remove it`,
      );
    }
  }

  return warnings;
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

function syncRequiredSurfaces(
  targetDir: string,
  manifest: WikiManifest,
  checkOnly: boolean,
  synced: string[],
): void {
  for (const surface of manifest.requiredSurfaces) {
    const absPath = path.join(targetDir, surface);
    if (fs.existsSync(absPath)) continue;

    if (!checkOnly) {
      fs.mkdirSync(absPath, { recursive: true });
    }
    synced.push(normalize(targetDir, absPath));
    debug(`synced required surface: ${surface}`);
  }
}

function syncIdState(
  targetDir: string,
  wikiDir: string,
  manifest: WikiManifest,
  checkOnly: boolean,
  synced: string[],
): Result<void> {
  const idStatePath = path.join(wikiDir, '.id-state.json');
  const manifestState = initialIdState(manifest);
  const diskEntries = scanExistingEntries(targetDir, manifest);

  if (!fs.existsSync(idStatePath)) {
    const state: IdState = JSON.parse(JSON.stringify(manifestState)) as IdState;
    reconcileIdState(state, diskEntries);

    if (!checkOnly) {
      fs.writeFileSync(idStatePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    }
    synced.push(normalize(targetDir, idStatePath));
    debug('synced missing .id-state.json');
    return ok(undefined);
  }

  let current: IdState;
  try {
    current = JSON.parse(fs.readFileSync(idStatePath, 'utf-8')) as IdState;
  } catch (err) {
    return fail('SYNC_ERROR', `Failed to read ID state: ${String(err)}`, err);
  }

  const merged = mergeMissingIdStateEntries(current, manifestState);
  const reconciled = reconcileIdState(current, diskEntries);

  if (!merged && !reconciled) return ok(undefined);

  if (!checkOnly) {
    fs.writeFileSync(idStatePath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  }
  synced.push(normalize(targetDir, idStatePath));
  debug('synced ID state entries');
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Sync contract templates into a bootstrapped consuming repo.
 *
 * - `check` mode: report what would change without writing
 * - Normal mode: overwrite record templates and update contract metadata
 * - Bootstrap surfaces are never overwritten — only drift-reported
 */
export async function sync(opts: SyncOpts): Promise<Result<SyncResult>> {
  if (opts.verbose) setVerbose(true);

  const targetDir = path.resolve(opts.dir);
  const wikiDir = path.join(targetDir, 'wiki');
  const checkOnly = opts.check ?? false;

  debug(`sync target: ${targetDir}`);
  debug(`check-only: ${checkOnly}`);

  // Verify the target is bootstrapped
  const contractPath = path.join(wikiDir, '.wiki-contract.json');
  if (!fs.existsSync(contractPath)) {
    return fail(
      'NOT_BOOTSTRAPPED',
      `Target does not appear to be bootstrapped — missing ${contractPath}`,
    );
  }

  // Load manifest
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

  const synced: string[] = [];
  const drifted: string[] = [];
  const skipped: string[] = [];
  const adopted: string[] = [];

  // Resolve and validate the --adopt surface if provided.
  let adoptSurface: string | undefined;
  if (opts.adopt !== undefined) {
    // Accept bare name ("schema.md") or wiki-relative path ("wiki/schema.md").
    const bare = opts.adopt.replace(/^wiki\//, '');
    if (!BOOTSTRAP_SURFACES.includes(bare)) {
      return fail(
        'SYNC_ERROR',
        `--adopt: "${opts.adopt}" is not a valid bootstrap surface. ` +
          `Must be one of: ${BOOTSTRAP_SURFACES.join(', ')}`,
      );
    }
    adoptSurface = bare;
  }

  // 1. Upgrade repo-local required surfaces and allocator state.
  syncRequiredSurfaces(targetDir, manifest, checkOnly, synced);
  const idStateResult = syncIdState(targetDir, wikiDir, manifest, checkOnly, synced);
  if (!idStateResult.ok) return idStateResult;

  // 2. Sync record templates
  const templatesResult = getRecordTemplates();
  if (!templatesResult.ok) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read templates: ${templatesResult.message}`);
  }

  const templateDest = path.join(wikiDir, 'templates');
  if (!fs.existsSync(templateDest)) {
    if (!checkOnly) {
      fs.mkdirSync(templateDest, { recursive: true });
    }
  }

  for (const srcPath of templatesResult.data) {
    const filename = path.basename(srcPath);
    const destPath = path.join(templateDest, filename);
    const srcContent = fs.readFileSync(srcPath, 'utf-8');

    if (!fs.existsSync(destPath)) {
      // Template missing in target — needs sync
      if (!checkOnly) {
        fs.writeFileSync(destPath, srcContent, 'utf-8');
      }
      synced.push(normalize(targetDir, destPath));
      debug(`synced template: ${filename}`);
    } else {
      const destContent = fs.readFileSync(destPath, 'utf-8');
      if (normalizeEol(srcContent) !== normalizeEol(destContent)) {
        // Template has drifted — overwrite in normal mode
        if (!checkOnly) {
          fs.writeFileSync(destPath, srcContent, 'utf-8');
        }
        synced.push(normalize(targetDir, destPath));
        debug(`updated template: ${filename}`);
      } else {
        skipped.push(normalize(targetDir, destPath));
        debug(`skipped template (unchanged): ${filename}`);
      }
    }
  }

  // 3. Copy skill files from contract/skills/<name>/ into .claude/skills/<name>/ and
  // .agents/skills/<name>/ (byte-identical, overwritten on drift — the templates pattern).
  const skillsResult = getSkillSources();
  if (!skillsResult.ok) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read skills: ${skillsResult.message}`);
  }

  for (const file of skillsResult.data) {
    const srcBytes = fs.readFileSync(file.srcPath);
    for (const runtimeDir of SKILL_RUNTIME_DIRS) {
      const destPath = path.join(targetDir, runtimeDir, file.skill, file.relPath);

      if (fs.existsSync(destPath) && fs.readFileSync(destPath).equals(srcBytes)) {
        skipped.push(normalize(targetDir, destPath));
        debug(`skipped skill file (unchanged): ${destPath}`);
        continue;
      }

      if (!checkOnly) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, srcBytes);
      }
      synced.push(normalize(targetDir, destPath));
      debug(`synced skill file: ${destPath}`);
    }
  }

  // 4. Check drift on bootstrap surfaces; adopt the named surface if requested.
  const bsDir = bootstrapDir();
  for (const surface of BOOTSTRAP_SURFACES) {
    const destPath = path.join(wikiDir, surface);
    const srcPath = path.join(bsDir, surface);

    if (!fs.existsSync(destPath) || !fs.existsSync(srcPath)) {
      continue;
    }

    const srcContent = fs.readFileSync(srcPath, 'utf-8');
    const destContent = fs.readFileSync(destPath, 'utf-8');

    const hasDrift = normalizeEol(srcContent) !== normalizeEol(destContent);

    if (adoptSurface === surface) {
      // Adopt: overwrite dest with seed content, preserving dest's EOL style.
      if (!checkOnly) {
        const eol = fs.existsSync(destPath) ? dominantEol(destContent) : '\n';
        const normalized = normalizeEol(srcContent);
        const output = eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
        fs.writeFileSync(destPath, output, 'utf-8');
      }
      adopted.push(`wiki/${surface}`);
      debug(`adopted: wiki/${surface}`);
    } else if (hasDrift) {
      drifted.push(`wiki/${surface}`);
      debug(`drift detected: wiki/${surface}`);
    }
  }

  // 5. Update contract metadata with current contractVersion and lastSyncedAt (unless check-only)
  if (!checkOnly) {
    try {
      const raw = fs.readFileSync(contractPath, 'utf-8');
      const meta = JSON.parse(raw) as WikiContractMetadata;
      meta.contractVersion = manifest.contractVersion;
      meta.lastSyncedAt = new Date().toISOString();
      fs.writeFileSync(contractPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
      debug('updated .wiki-contract.json with lastSyncedAt');
    } catch (err) {
      return fail(
        'SYNC_ERROR',
        `Failed to update contract metadata: ${String(err)}`,
        err,
      );
    }
  }

  // 6. Write agent instructions managed block
  const updated: string[] = [];
  const instructions: string[] = [];

  const dispatch = dispatchInstalled(targetDir);

  if (agentInstructionsSections) {
    const blockBody = assembleBlockBody(agentInstructionsSections, { dispatch });
    const blockResult = writeManagedBlock(targetDir, blockBody, { dryRun: checkOnly });
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
  const mcpResult = writeMcpConfig(targetDir, { client: mcpClient, dispatch, dryRun: checkOnly });
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
  const gitignoreResult = ensureGitignoreEntries(targetDir, { dryRun: checkOnly });
  if (gitignoreResult.action !== 'unchanged') {
    updated.push('.gitignore');
  }

  // 9. Warn-only checks: user-global role drift, user-global skill shadowing (WK-0240
  // stage 2 rulings 2–3, 7). Computed in both normal and --check mode; never writes
  // under $HOME and never changes `ok`.
  const skillNames = Array.from(new Set(skillsResult.data.map(f => f.skill)));
  const warnings = [...computeRoleWarnings(), ...computeSkillWarnings(skillNames)];

  return ok({
    synced,
    drifted,
    skipped,
    updated,
    instructions: instructions.length > 0 ? instructions : undefined,
    adopted: adopted.length > 0 ? adopted : undefined,
    warnings,
  });
}
