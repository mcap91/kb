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
  getManagedCopies,
  managedCopyLayer,
  bootstrapDir,
  getAgentInstructionsSections,
  renderBootstrapSurface,
  type AgentInstructionsSection,
} from './contract.js';
import {
  writeManagedBlock,
  assembleBlockBody,
  checkBlockBudget,
  dispatchInstalled,
  planningInstalled,
  layerActive,
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
 * Warn when a user-global copy of a role this repo ships would beat the repo copy:
 * `~/.claude/commands/<role>.md` shadows `.claude/commands/<role>.md` (Claude resolves
 * personal over project), and `~/.agents/skills/<role>` duplicates
 * `.agents/skills/<role>` (Codex shows both). WK-0261 s6.
 */
function computeRoleWarnings(roleNames: string[]): string[] {
  const warnings: string[] = [];
  for (const role of roleNames) {
    const claudePath = path.join(os.homedir(), '.claude', 'commands', `${role}.md`);
    if (lexists(claudePath)) {
      warnings.push(
        `user-global role ${claudePath} shadows the repo copy .claude/commands/${role}.md; remove it`,
      );
    }

    const codexPath = path.join(os.homedir(), '.agents', 'skills', role);
    if (lexists(codexPath)) {
      warnings.push(
        `user-global skill ${codexPath} duplicates the repo copy .agents/skills/${role} (Codex shows both in skill selectors); remove it`,
      );
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
  layers: { planning: boolean; dispatch: boolean },
  checkOnly: boolean,
  synced: string[],
): void {
  // WK-0261: only create a missing required surface while its layer is active.
  // A surface's layer going inactive never deletes an existing directory — it
  // may hold user records (Removal semantics: never record directories).
  for (const [surface, layer] of Object.entries(manifest.requiredSurfaces)) {
    if (!layerActive(layer, layers)) continue;
    const absPath = path.join(targetDir, surface);
    if (fs.existsSync(absPath)) continue;

    if (!checkOnly) {
      fs.mkdirSync(absPath, { recursive: true });
    }
    synced.push(normalize(targetDir, absPath));
    debug(`synced required surface: ${surface}`);
  }
}

/** Remove `dirPath` and any now-empty parent skill folders, bottom-up. Never
 *  removes a directory that still contains a file (HO-0215 item 4). */
function removeEmptyDirRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirRecursive(path.join(dirPath, entry.name));
    }
  }
  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
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
  const removed: string[] = [];
  const conflictWarnings: string[] = [];

  // Refuse before any write, in both modes, when the stamp exists but cannot be parsed
  // (WK-0261 fix-up). The NOT_BOOTSTRAPPED check above still comes first.
  const planningResult = planningInstalled(targetDir);
  if (!planningResult.ok) return planningResult;
  const planning = planningResult.data;
  const dispatch = dispatchInstalled(targetDir);
  const layers = { planning, dispatch };

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
  syncRequiredSurfaces(targetDir, manifest, layers, checkOnly, synced);
  const idStateResult = syncIdState(targetDir, wikiDir, manifest, checkOnly, synced);
  if (!idStateResult.ok) return idStateResult;

  // 2. Sync record templates whose layer is active (add/overwrite-on-drift, as
  // before); for a template whose layer is inactive (including one absent from
  // manifest.templateLayers — shipped in no layer, e.g. plan.md), run the kb-owned
  // delete pass instead (WK-0261 Removal semantics, HO-0204 F2): delete only when
  // the on-disk file still byte-matches (EOL-normalized) the contract source;
  // a modified known-name file is kept and reported as a conflict warning.
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
    const layer = manifest.templateLayers[filename];
    const active = !!layer && layerActive(layer, layers);

    if (active) {
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
      continue;
    }

    // Inactive layer (or no layer at all): delete pass only — never recreate.
    if (!fs.existsSync(destPath)) continue;
    const destContent = fs.readFileSync(destPath, 'utf-8');
    if (normalizeEol(destContent) === normalizeEol(srcContent)) {
      if (!checkOnly) {
        fs.unlinkSync(destPath);
      }
      removed.push(normalize(targetDir, destPath));
      debug(`removed template (layer inactive): ${filename}`);
    } else {
      conflictWarnings.push(
        `wiki/templates/${filename} is no longer shipped by your active install layer but its ` +
          `content differs from contract/templates/${filename}; remove it manually if you no longer need it`,
      );
      debug(`kept modified template (conflict): ${filename}`);
    }
  }

  // 3. Sync the managed skill and role copies whose layer is active (byte-identical,
  // overwritten on drift — the templates pattern); run the same delete pass for a
  // copy whose layer is inactive, then prune its folder once empty (WK-0261 s3, s6).
  const copiesResult = getManagedCopies();
  if (!copiesResult.ok) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read skills and roles: ${copiesResult.message}`);
  }

  const kbRoot = findKbRoot();
  const activeCopyNames = { skill: new Set<string>(), role: new Set<string>() };
  const inactiveFolders = new Set<string>();

  for (const copy of copiesResult.data) {
    const srcBytes = fs.readFileSync(copy.srcPath);
    const layer = managedCopyLayer(manifest, copy);
    const active = !!layer && layerActive(layer, layers);
    const destPath = path.join(targetDir, copy.dest);

    if (active) {
      activeCopyNames[copy.kind].add(copy.name);
      if (fs.existsSync(destPath) && fs.readFileSync(destPath).equals(srcBytes)) {
        skipped.push(copy.dest);
        debug(`skipped ${copy.kind} copy (unchanged): ${copy.dest}`);
        continue;
      }

      if (!checkOnly) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, srcBytes);
      }
      synced.push(copy.dest);
      debug(`synced ${copy.kind} copy: ${copy.dest}`);
      continue;
    }

    // Inactive layer: delete pass only.
    if (copy.folder) inactiveFolders.add(copy.folder);
    if (!fs.existsSync(destPath)) continue;
    if (fs.readFileSync(destPath).equals(srcBytes)) {
      if (!checkOnly) {
        fs.unlinkSync(destPath);
      }
      removed.push(copy.dest);
      debug(`removed ${copy.kind} copy (layer inactive): ${copy.dest}`);
    } else {
      const src = path.relative(kbRoot, copy.srcPath).replace(/\\/g, '/');
      conflictWarnings.push(
        `${copy.dest} is no longer shipped by your active install layer but its content differs ` +
          `from ${src}; remove it manually if you no longer need it`,
      );
      debug(`kept modified ${copy.kind} copy (conflict): ${copy.dest}`);
    }
  }

  // Remove now-empty folders left behind by the delete pass above (never removes a
  // folder that still holds a file).
  if (!checkOnly) {
    for (const folder of inactiveFolders) {
      removeEmptyDirRecursive(path.join(targetDir, folder));
    }
  }

  // 4. Check drift on bootstrap surfaces; adopt the named surface if requested.
  // Both the drift comparison and the adopted content are the *emitted* form for
  // the repo's active layers (WK-0261: dispatch-conditional spans stripped the
  // same way bootstrap stripped them), so a freshly bootstrapped repo reports no
  // drift and `--adopt` never reintroduces a span the repo's layer set excludes.
  const bsDir = bootstrapDir();
  for (const surface of BOOTSTRAP_SURFACES) {
    const destPath = path.join(wikiDir, surface);
    const srcPath = path.join(bsDir, surface);

    if (!fs.existsSync(destPath) || !fs.existsSync(srcPath)) {
      continue;
    }

    const srcContent = renderBootstrapSurface(fs.readFileSync(srcPath, 'utf-8'), { dispatch });
    const destContent = fs.readFileSync(destPath, 'utf-8');

    const hasDrift = normalizeEol(srcContent) !== normalizeEol(destContent);

    if (adoptSurface === surface) {
      // Adopt: overwrite dest with the emitted seed content, preserving dest's EOL style.
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

  if (agentInstructionsSections) {
    const blockBody = assembleBlockBody(agentInstructionsSections, { planning, dispatch });
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
  // stage 2 rulings 2–3, 7) — the shadow check runs only for skills in the active
  // layer set (WK-0261 Context item 6). Computed in both normal and --check mode;
  // never writes under $HOME and never changes `ok`.
  const warnings = [
    ...computeRoleWarnings([...activeCopyNames.role]),
    ...computeSkillWarnings([...activeCopyNames.skill]),
    ...conflictWarnings,
  ];

  return ok({
    synced,
    drifted,
    skipped,
    updated,
    instructions: instructions.length > 0 ? instructions : undefined,
    adopted: adopted.length > 0 ? adopted : undefined,
    removed,
    warnings,
  });
}
