/**
 * Contract resolution module.
 *
 * Locates the kb repo root (where contract/ lives) and provides helpers
 * to load the manifest, list bootstrap templates, list record templates,
 * and read individual templates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ok, type Result } from './errors.js';
import type { ContractLayer, WikiManifest } from './types.js';
import { debug } from './debug.js';

// ---------------------------------------------------------------------------
// Repo root resolution
// ---------------------------------------------------------------------------

/** Directory containing this source file. */
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find the kb repo root — the directory that contains `contract/manifest.json`.
 *
 * Walks upward from the location of this source file, which is always inside
 * the kb repo at `packages/wiki-core/src/`.
 */
export function findKbRoot(): string {
  // Start from this file's directory and walk up.
  let dir = path.resolve(THIS_DIR);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, 'contract', 'manifest.json');
    if (fs.existsSync(candidate)) {
      debug(`kb root resolved: ${dir}`);
      return dir;
    }
    dir = path.dirname(dir);
  }

  // Fallback: three levels up from packages/wiki-core/src/
  const fallback = path.resolve(THIS_DIR, '..', '..', '..');
  debug(`kb root fallback: ${fallback}`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve a path inside the contract directory. */
export function contractPath(...segments: string[]): string {
  return path.join(findKbRoot(), 'contract', ...segments);
}

/** Path to the manifest file. */
export function manifestPath(): string {
  return contractPath('manifest.json');
}

/** Path to the bootstrap templates directory. */
export function bootstrapDir(): string {
  return contractPath('bootstrap');
}

/** Path to the record templates directory. */
export function templatesDir(): string {
  return contractPath('templates');
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Load and parse `contract/manifest.json`.
 */
export function loadManifest(): Result<WikiManifest> {
  const mp = manifestPath();
  debug(`loading manifest from ${mp}`);

  if (!fs.existsSync(mp)) {
    return fail('CONTRACT_NOT_FOUND', `Manifest not found at ${mp}`);
  }

  try {
    const raw = fs.readFileSync(mp, 'utf-8');
    const parsed = JSON.parse(raw) as WikiManifest;
    return ok(parsed);
  } catch (err) {
    return fail('MANIFEST_ERROR', `Failed to parse manifest: ${String(err)}`, err);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap template helpers
// ---------------------------------------------------------------------------

/**
 * List bootstrap template file paths (files inside contract/bootstrap/).
 */
export function getBootstrapTemplates(): Result<string[]> {
  const dir = bootstrapDir();

  if (!fs.existsSync(dir)) {
    return fail('CONTRACT_NOT_FOUND', `Bootstrap directory not found at ${dir}`);
  }

  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const paths = entries.map(f => path.join(dir, f));
    debug(`bootstrap templates: ${paths.join(', ')}`);
    return ok(paths);
  } catch (err) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read bootstrap directory: ${String(err)}`, err);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap-doc span stripping (WK-0261 Scope "Surface inventory"; HO-0204 F1)
// ---------------------------------------------------------------------------

/**
 * Marks a span in a `contract/bootstrap/*.md` source that is emitted to a
 * consuming repo only while the dispatch layer is active (`wiki/.dispatch/`
 * present). Spans occupy whole lines so stripping never leaves a partial line.
 */
const DISPATCH_SPAN_RE = /^[^\S\n]*<!-- kb:dispatch-span -->\n([\s\S]*?)^[^\S\n]*<!-- \/kb:dispatch-span -->\n?/gm;

/**
 * Render a bootstrap-doc source for emission to a consuming repo (WK-0261):
 * strip `<!-- kb:dispatch-span -->...<!-- /kb:dispatch-span -->` markers,
 * keeping the interior text only while `opts.dispatch` is true, then collapse
 * any resulting run of 3+ blank lines to one. PLN/VAL/plans/value-reports
 * mentions carry no marker — they are never emitted, so the source text
 * itself excludes them (Resolutions row 3).
 *
 * Used identically by bootstrap (first write) and sync (drift check / --adopt)
 * so a freshly bootstrapped repo's bootstrap docs always report zero drift.
 */
export function renderBootstrapSurface(content: string, opts: { dispatch: boolean }): string {
  const stripped = content.replace(DISPATCH_SPAN_RE, (_match, inner: string) =>
    opts.dispatch ? inner : '',
  );
  return stripped.replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Record template helpers
// ---------------------------------------------------------------------------

/**
 * List record template file paths (files inside contract/templates/).
 */
export function getRecordTemplates(): Result<string[]> {
  const dir = templatesDir();

  if (!fs.existsSync(dir)) {
    return fail('CONTRACT_NOT_FOUND', `Templates directory not found at ${dir}`);
  }

  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const paths = entries.map(f => path.join(dir, f));
    debug(`record templates: ${paths.join(', ')}`);
    return ok(paths);
  } catch (err) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read templates directory: ${String(err)}`, err);
  }
}

// ---------------------------------------------------------------------------
// Skill helpers (WK-0240 stage 2)
// ---------------------------------------------------------------------------

/** Path to the skills directory. */
export function skillsDir(): string {
  return contractPath('skills');
}

/** Runtime directories that receive a managed copy of each contract/skills/<name>/ folder. */
export const SKILL_RUNTIME_DIRS = ['.claude/skills', '.agents/skills'] as const;

/** One file to deliver for one skill: its name, absolute source path, and path relative to the skill folder. */
export interface SkillFile {
  skill: string;
  srcPath: string;
  relPath: string;
}

/**
 * List every file under every `contract/skills/<name>/` folder, recursively.
 * A missing `contract/skills/` directory is an empty list, not an error — stage 2
 * ships ahead of any guaranteed skill folder.
 */
export function getSkillSources(): Result<SkillFile[]> {
  const dir = skillsDir();

  if (!fs.existsSync(dir)) {
    return ok([]);
  }

  try {
    const skillNames = fs
      .readdirSync(dir)
      .filter(name => fs.statSync(path.join(dir, name)).isDirectory());

    const files: SkillFile[] = [];
    for (const skill of skillNames) {
      const skillPath = path.join(dir, skill);
      const entries = fs.readdirSync(skillPath, { recursive: true }) as string[];
      for (const entry of entries) {
        const abs = path.join(skillPath, entry);
        if (fs.statSync(abs).isFile()) {
          files.push({ skill, srcPath: abs, relPath: entry.replace(/\\/g, '/') });
        }
      }
    }

    files.sort((a, b) => (a.skill + '/' + a.relPath).localeCompare(b.skill + '/' + b.relPath));
    debug(`skill sources: ${files.map(f => `${f.skill}/${f.relPath}`).join(', ')}`);
    return ok(files);
  } catch (err) {
    return fail('CONTRACT_NOT_FOUND', `Failed to read skills directory: ${String(err)}`, err);
  }
}

// ---------------------------------------------------------------------------
// Managed repo copies: skills and roles (WK-0240 stage 2, WK-0261 s6)
// ---------------------------------------------------------------------------

/** Path to the role sources directory. */
export function rolesDir(): string {
  return contractPath('roles');
}

/**
 * One kb-owned file copied byte-identical into a consuming repo. `kind` + `name`
 * key the install layer (manifest `skillLayers` / `roleLayers`). `folder` is the
 * repo-relative folder the copy owns, pruned when empty after the delete pass.
 */
export interface ManagedCopy {
  kind: 'skill' | 'role';
  name: string;
  srcPath: string;
  dest: string;
  folder?: string;
}

/** The install layer that ships a managed copy; undefined means no layer ships it. */
export function managedCopyLayer(manifest: WikiManifest, copy: ManagedCopy): ContractLayer | undefined {
  return copy.kind === 'skill' ? manifest.skillLayers[copy.name] : manifest.roleLayers[copy.name];
}

/**
 * Every managed copy kb can write: each `contract/skills/<name>/` file into
 * `.claude/skills/<name>/` and `.agents/skills/<name>/`, and each
 * `contract/roles/<role>.md` into `.claude/commands/<role>.md` (Claude) and
 * `.agents/skills/<role>/SKILL.md` (Codex) — one source per role (WK-0261 row 14).
 */
export function getManagedCopies(): Result<ManagedCopy[]> {
  const skillsResult = getSkillSources();
  if (!skillsResult.ok) return skillsResult;

  const copies: ManagedCopy[] = [];
  for (const file of skillsResult.data) {
    for (const runtimeDir of SKILL_RUNTIME_DIRS) {
      copies.push({
        kind: 'skill',
        name: file.skill,
        srcPath: file.srcPath,
        dest: `${runtimeDir}/${file.skill}/${file.relPath}`,
        folder: `${runtimeDir}/${file.skill}`,
      });
    }
  }

  const dir = rolesDir();
  if (fs.existsSync(dir)) {
    try {
      const roleFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
      for (const file of roleFiles) {
        const role = path.basename(file, '.md');
        const srcPath = path.join(dir, file);
        copies.push({ kind: 'role', name: role, srcPath, dest: `.claude/commands/${file}` });
        copies.push({
          kind: 'role',
          name: role,
          srcPath,
          dest: `.agents/skills/${role}/SKILL.md`,
          folder: `.agents/skills/${role}`,
        });
      }
    } catch (err) {
      return fail('CONTRACT_NOT_FOUND', `Failed to read roles directory: ${String(err)}`, err);
    }
  }

  return ok(copies);
}

/**
 * A per-tool section of the managed agent-instructions block (WK-0229 ruling 14).
 * `requires: 'planning'` means the section is dropped unless the planning layer is
 * active (a `"planning"` entry in `wiki/.wiki-contract.json` or `wiki/.dispatch/`);
 * `requires: 'dispatch'` means it is dropped when `wiki/.dispatch/` is absent.
 */
export interface AgentInstructionsSection {
  id: 'wiki' | 'dispatch' | 'guidelines' | 'footer';
  requires?: 'planning' | 'dispatch';
  body: string;
}

/** Fixed emission order for managed-block sections (WK-0229 ruling 14). */
const AGENT_INSTRUCTIONS_SECTION_ORDER: Array<Pick<AgentInstructionsSection, 'id' | 'requires'>> = [
  { id: 'wiki' },
  { id: 'dispatch', requires: 'dispatch' },
  { id: 'guidelines', requires: 'planning' },
  { id: 'footer', requires: 'planning' },
];

/**
 * Read the per-tool agent-instructions sections from contract/agent-instructions/.
 */
export function getAgentInstructionsSections(): Result<AgentInstructionsSection[]> {
  const dir = path.join(findKbRoot(), 'contract', 'agent-instructions');
  const sections: AgentInstructionsSection[] = [];

  for (const { id, requires } of AGENT_INSTRUCTIONS_SECTION_ORDER) {
    const tp = path.join(dir, `${id}.md`);
    debug(`reading agent instructions section from ${tp}`);

    if (!fs.existsSync(tp)) {
      return fail('FILE_NOT_FOUND', `Agent instructions section not found at ${tp}`);
    }

    try {
      const content = fs.readFileSync(tp, 'utf-8').replace(/\n$/, '');
      sections.push({ id, requires, body: content });
    } catch (err) {
      return fail('FILE_NOT_FOUND', `Failed to read agent instructions section ${id}: ${String(err)}`, err);
    }
  }

  return ok(sections);
}

/**
 * Read a specific template by filename (e.g. `"issue.md"` or `"handoff.md"`).
 */
export function getTemplate(name: string): Result<string> {
  const tp = path.join(templatesDir(), name);

  if (!fs.existsSync(tp)) {
    return fail('FILE_NOT_FOUND', `Template not found: ${tp}`);
  }

  try {
    const content = fs.readFileSync(tp, 'utf-8');
    return ok(content);
  } catch (err) {
    return fail('FILE_NOT_FOUND', `Failed to read template ${name}: ${String(err)}`, err);
  }
}
