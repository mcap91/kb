/**
 * Comprehensive tests for wiki-core.
 *
 * Covers: bootstrap, sync-contract, allocation, create, lint, generate, search,
 * explicit HO rejection, and explicit wiki/handoffs/ exclusion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import {
  bootstrap,
  sync,
  allocate,
  create,
  importPlan,
  validatePlan,
  archivePlan,
  lint,
  generate,
  buildSearchIndex,
  search,
} from '../packages/wiki-core/src/index.js';

import type {
  WikiContractMetadata,
  IdState,
  WikiPrefix,
  PlanBundleManifest,
} from '../packages/wiki-core/src/index.js';

import {
  createTmpDir,
  createBootstrappedRepo,
  writeRecord,
  readJson,
  fileExists,
  readText,
  type TmpRepo,
} from './helpers/tmp-repo.js';

// ---------------------------------------------------------------------------
// Bootstrap Tests
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('creates all expected directories', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const expectedDirs = [
      'wiki/issues',
      'wiki/initiatives',
      'wiki/decisions',
      'wiki/sources',
      'wiki/areas',
      'wiki/plans',
      'wiki/handoffs',
    ];
    for (const dir of expectedDirs) {
      expect(
        fs.existsSync(path.join(tmp.dir, dir)),
        `Expected directory ${dir} to exist`,
      ).toBe(true);
    }
  });

  it('writes .wiki-contract.json with correct metadata', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/my-repo' });

    const meta = readJson<WikiContractMetadata>(tmp.dir, 'wiki/.wiki-contract.json');
    expect(meta.repo).toBe('test/my-repo');
    expect(meta.contractVersion).toBeTruthy();
    expect(meta.bootstrappedAt).toBeTruthy();
  });

  it('writes .id-state.json with initial state', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    // Should have entries for prefix-based allocated types
    expect(state['WK']).toEqual({ next: 1, allocated: [] });
    expect(state['IN']).toEqual({ next: 1, allocated: [] });
    expect(state['DEC']).toEqual({ next: 1, allocated: [] });
    expect(state['SRC']).toEqual({ next: 1, allocated: [] });
    expect(state['PLN']).toEqual({ next: 1, allocated: [] });
  });

  it('preserves existing metadata and merges missing ID state entries', async () => {
    tmp = createTmpDir();
    fs.mkdirSync(path.join(tmp.dir, 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/.wiki-contract.json'),
      JSON.stringify({
        contractVersion: '0.0.1',
        repo: 'test/existing',
        bootstrappedAt: '2026-01-01T00:00:00.000Z',
      }, null, 2) + '\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/.id-state.json'),
      JSON.stringify({
        WK: { next: 18, allocated: [1, 2, 17] },
        IN: { next: 3, allocated: [1, 2] },
      }, null, 2) + '\n',
      'utf-8',
    );

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const meta = readJson<WikiContractMetadata>(tmp.dir, 'wiki/.wiki-contract.json');
    expect(meta.repo).toBe('test/existing');
    expect(meta.bootstrappedAt).toBe('2026-01-01T00:00:00.000Z');

    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    expect(state['WK']).toEqual({ next: 18, allocated: [1, 2, 17] });
    expect(state['IN']).toEqual({ next: 3, allocated: [1, 2] });
    expect(state['PLN']).toEqual({ next: 1, allocated: [] });
  });

  it('copies record templates', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    expect(fileExists(tmp.dir, 'wiki/templates/issue.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/templates/initiative.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/templates/decision.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/templates/source.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/templates/area.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/templates/plan.md')).toBe(true);
  });

  it('copies handoff template', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    expect(fileExists(tmp.dir, 'wiki/templates/handoff.md')).toBe(true);
  });

  it('creates shared bootstrap surfaces when absent', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    expect(fileExists(tmp.dir, 'wiki/schema.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/conventions.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/index.md')).toBe(true);
  });

  it('does not overwrite existing shared bootstrap surfaces', async () => {
    tmp = createTmpDir();

    // Pre-create a custom schema.md
    fs.mkdirSync(path.join(tmp.dir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'wiki/schema.md'), 'custom content', 'utf-8');

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    const content = readText(tmp.dir, 'wiki/schema.md');
    expect(content).toBe('custom content');
  });

  it('preserves existing consumer content in docs/, AGENTS.md, CLAUDE.md', async () => {
    tmp = createTmpDir();

    // Pre-create existing files
    fs.mkdirSync(path.join(tmp.dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'docs/existing.md'), 'doc content', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), 'agent doc', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'CLAUDE.md'), 'claude doc', 'utf-8');

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    expect(readText(tmp.dir, 'docs/existing.md')).toBe('doc content');
    // Bootstrap now adds a managed block but preserves consumer content
    expect(readText(tmp.dir, 'AGENTS.md')).toContain('agent doc');
    expect(readText(tmp.dir, 'CLAUDE.md')).toContain('claude doc');
    expect(readText(tmp.dir, 'AGENTS.md')).toContain('<!-- BEGIN kb-managed -->');
    expect(readText(tmp.dir, 'CLAUDE.md')).toContain('<!-- BEGIN kb-managed -->');
  });

  it('reconciles ID counters from existing entry files when .id-state.json is absent', async () => {
    tmp = createTmpDir();

    const wikiDir = path.join(tmp.dir, 'wiki');
    fs.mkdirSync(path.join(wikiDir, 'issues'), { recursive: true });
    fs.mkdirSync(path.join(wikiDir, 'initiatives'), { recursive: true });

    for (let i = 1; i <= 16; i++) {
      const id = `WK-${String(i).padStart(4, '0')}`;
      writeRecord(tmp.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Issue ${i}`,
        type: 'task',
        status: 'inbox',
        priority: 'medium',
        owner: 'test',
        created: '2026-01-01',
        updated: '2026-01-01',
      });
    }

    writeRecord(tmp.dir, 'wiki/initiatives/IN-0001.md', {
      id: 'IN-0001',
      title: 'Init 1',
      status: 'todo',
      priority: 'medium',
      owner: 'test',
      created: '2026-01-01',
      updated: '2026-01-01',
    });
    writeRecord(tmp.dir, 'wiki/initiatives/IN-0002.md', {
      id: 'IN-0002',
      title: 'Init 2',
      status: 'todo',
      priority: 'medium',
      owner: 'test',
      created: '2026-01-01',
      updated: '2026-01-01',
    });

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    expect(state['WK'].next).toBe(17);
    expect(state['WK'].allocated).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    expect(state['IN'].next).toBe(3);
    expect(state['IN'].allocated).toEqual([1, 2]);
    expect(state['DEC']).toEqual({ next: 1, allocated: [] });
    expect(state['SRC']).toEqual({ next: 1, allocated: [] });
    expect(state['PLN']).toEqual({ next: 1, allocated: [] });
  });

  it('reconciles stale ID counters in existing .id-state.json', async () => {
    tmp = createTmpDir();

    const wikiDir = path.join(tmp.dir, 'wiki');
    fs.mkdirSync(path.join(wikiDir, 'issues'), { recursive: true });

    for (let i = 1; i <= 5; i++) {
      const id = `WK-${String(i).padStart(4, '0')}`;
      writeRecord(tmp.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Issue ${i}`,
        type: 'task',
        status: 'inbox',
        priority: 'medium',
        owner: 'test',
        created: '2026-01-01',
        updated: '2026-01-01',
      });
    }

    fs.writeFileSync(
      path.join(wikiDir, '.id-state.json'),
      JSON.stringify({
        WK: { next: 1, allocated: [] },
        IN: { next: 1, allocated: [] },
        DEC: { next: 1, allocated: [] },
        SRC: { next: 1, allocated: [] },
        PLN: { next: 1, allocated: [] },
      }, null, 2) + '\n',
      'utf-8',
    );

    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    expect(result.ok).toBe(true);

    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    expect(state['WK'].next).toBe(6);
    expect(state['WK'].allocated).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not clobber existing entries after reconciliation', async () => {
    tmp = createTmpDir();
    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    for (let i = 1; i <= 3; i++) {
      const id = `WK-${String(i).padStart(4, '0')}`;
      writeRecord(tmp.dir, `wiki/issues/${id}.md`, {
        id,
        title: `Existing issue ${i}`,
        type: 'task',
        status: 'inbox',
        priority: 'medium',
        owner: 'test',
        created: '2026-01-01',
        updated: '2026-01-01',
      });
    }

    fs.unlinkSync(path.join(tmp.dir, 'wiki/.id-state.json'));

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });

    const createResult = await create({ dir: tmp.dir, prefix: 'WK', title: 'New issue' });
    expect(createResult.ok).toBe(true);
    if (createResult.ok) {
      expect(createResult.data.id).toBe('WK-0004');
    }

    const original = readText(tmp.dir, 'wiki/issues/WK-0001.md');
    expect(original).toContain('Existing issue 1');
  });

  it('dry-run reports but does not create files', async () => {
    tmp = createTmpDir();
    const result = await bootstrap({ dir: tmp.dir, repo: 'test/repo', dryRun: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created.length).toBeGreaterThan(0);
    }

    // The wiki directory should NOT actually exist after a dry run
    expect(fs.existsSync(path.join(tmp.dir, 'wiki', '.wiki-contract.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sync-Contract Tests
// ---------------------------------------------------------------------------

describe('sync-contract', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('updates record templates', async () => {
    tmp = await createBootstrappedRepo();

    // Modify a template in the target to make it stale
    const templatePath = path.join(tmp.dir, 'wiki/templates/issue.md');
    fs.writeFileSync(templatePath, 'stale template', 'utf-8');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.synced).toContain('wiki/templates/issue.md');
    }

    // Template should be restored
    const content = readText(tmp.dir, 'wiki/templates/issue.md');
    expect(content).not.toBe('stale template');
  });

  it('reports drift on shared bootstrap surfaces', async () => {
    tmp = await createBootstrappedRepo();

    // Modify a shared surface
    fs.writeFileSync(path.join(tmp.dir, 'wiki/schema.md'), 'customized schema', 'utf-8');

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.drifted).toContain('wiki/schema.md');
    }
  });

  it('does not overwrite wiki/schema.md, wiki/conventions.md, wiki/index.md', async () => {
    tmp = await createBootstrappedRepo();

    // Customize all three surfaces
    fs.writeFileSync(path.join(tmp.dir, 'wiki/schema.md'), 'my schema', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'wiki/conventions.md'), 'my conventions', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'wiki/index.md'), 'my index', 'utf-8');

    await sync({ dir: tmp.dir });

    // All should still be customized
    expect(readText(tmp.dir, 'wiki/schema.md')).toBe('my schema');
    expect(readText(tmp.dir, 'wiki/conventions.md')).toBe('my conventions');
    expect(readText(tmp.dir, 'wiki/index.md')).toBe('my index');
  });

  it('--check mode reports without changing', async () => {
    tmp = await createBootstrappedRepo();

    // Make a template stale
    const templatePath = path.join(tmp.dir, 'wiki/templates/issue.md');
    fs.writeFileSync(templatePath, 'stale template', 'utf-8');

    const result = await sync({ dir: tmp.dir, check: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.synced).toContain('wiki/templates/issue.md');
    }

    // Template should still be stale (check mode does not write)
    expect(readText(tmp.dir, 'wiki/templates/issue.md')).toBe('stale template');
  });

  it('updates lastSyncedAt', async () => {
    tmp = await createBootstrappedRepo();

    const beforeMeta = readJson<WikiContractMetadata>(tmp.dir, 'wiki/.wiki-contract.json');
    expect(beforeMeta.lastSyncedAt).toBeUndefined();

    await sync({ dir: tmp.dir });

    const afterMeta = readJson<WikiContractMetadata>(tmp.dir, 'wiki/.wiki-contract.json');
    expect(afterMeta.lastSyncedAt).toBeTruthy();
  });

  it('upgrades required surfaces and missing ID state entries', async () => {
    tmp = await createBootstrappedRepo();

    fs.rmSync(path.join(tmp.dir, 'wiki/plans'), { recursive: true, force: true });
    fs.rmSync(path.join(tmp.dir, 'wiki/templates/plan.md'), { force: true });
    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    state['WK'] = { next: 7, allocated: [1, 2, 3, 4, 5, 6] };
    delete state['PLN'];
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/.id-state.json'),
      JSON.stringify(state, null, 2) + '\n',
      'utf-8',
    );

    const result = await sync({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.synced).toContain('wiki/plans');
      expect(result.data.synced).toContain('wiki/.id-state.json');
      expect(result.data.synced).toContain('wiki/templates/plan.md');
    }

    expect(fs.existsSync(path.join(tmp.dir, 'wiki/plans'))).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/templates/plan.md')).toBe(true);

    const upgradedState = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    expect(upgradedState['WK']).toEqual({ next: 7, allocated: [1, 2, 3, 4, 5, 6] });
    expect(upgradedState['PLN']).toEqual({ next: 1, allocated: [] });
  });

  it('--check mode reports upgrade changes without writing them', async () => {
    tmp = await createBootstrappedRepo();

    fs.rmSync(path.join(tmp.dir, 'wiki/plans'), { recursive: true, force: true });
    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    delete state['PLN'];
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/.id-state.json'),
      JSON.stringify(state, null, 2) + '\n',
      'utf-8',
    );

    const result = await sync({ dir: tmp.dir, check: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.synced).toContain('wiki/plans');
      expect(result.data.synced).toContain('wiki/.id-state.json');
    }

    expect(fs.existsSync(path.join(tmp.dir, 'wiki/plans'))).toBe(false);
    const unchangedState = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    expect(unchangedState['PLN']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Allocation Tests
// ---------------------------------------------------------------------------

describe('allocation', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('returns sequential IDs (WK-0001, WK-0002, etc.)', async () => {
    tmp = await createBootstrappedRepo();

    const r1 = await allocate({ dir: tmp.dir, prefix: 'WK' as WikiPrefix });
    const r2 = await allocate({ dir: tmp.dir, prefix: 'WK' as WikiPrefix });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.data.id).toBe('WK-0001');
      expect(r2.data.id).toBe('WK-0002');
    }
  });

  it('rejects invalid/unknown prefixes', async () => {
    tmp = await createBootstrappedRepo();

    const result = await allocate({ dir: tmp.dir, prefix: 'INVALID' as WikiPrefix });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_PREFIX');
    }
  });

  it('rejects HO prefix', async () => {
    tmp = await createBootstrappedRepo();

    const result = await allocate({ dir: tmp.dir, prefix: 'HO' as WikiPrefix });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_PREFIX');
    }
  });

  it('updates .id-state.json atomically', async () => {
    tmp = await createBootstrappedRepo();

    await allocate({ dir: tmp.dir, prefix: 'WK' as WikiPrefix });

    const state = readJson<IdState>(tmp.dir, 'wiki/.id-state.json');
    expect(state['WK'].next).toBe(2);
    expect(state['WK'].allocated).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// Create Tests
// ---------------------------------------------------------------------------

describe('create', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('creates WK record successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'WK', title: 'Test issue' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('WK-0001');
      expect(result.data.path).toContain('wiki/issues/WK-0001.md');
      expect(fileExists(tmp.dir, 'wiki/issues/WK-0001.md')).toBe(true);
    }
  });

  it('creates IN record successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'IN', title: 'Test initiative' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('IN-0001');
      expect(fileExists(tmp.dir, 'wiki/initiatives/IN-0001.md')).toBe(true);
    }
  });

  it('creates DEC record successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'DEC', title: 'Test decision' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('DEC-0001');
      expect(fileExists(tmp.dir, 'wiki/decisions/DEC-0001.md')).toBe(true);
    }
  });

  it('creates SRC record successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'SRC', title: 'Test source' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('SRC-0001');
      expect(fileExists(tmp.dir, 'wiki/sources/SRC-0001.md')).toBe(true);
    }
  });

  it('creates AREA record successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({
      dir: tmp.dir,
      prefix: 'AREA',
      title: 'Test Area',
      slug: 'test-area',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('test-area');
      expect(fileExists(tmp.dir, 'wiki/areas/test-area.md')).toBe(true);
    }
  });

  it('creates PLN record successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'PLN', title: 'Test plan' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('PLN-0001');
      expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001.md')).toBe(true);
    }

    const content = readText(tmp.dir, 'wiki/plans/PLN-0001.md');
    expect(content).toContain('id: "PLN-0001"');
    expect(content).toContain('title: "Test plan"');
    expect(content).toContain('status: draft');
    expect(content).toContain('owner: "unassigned"');
    expect(content).toContain('bundle_path: "wiki/plans/PLN-0001/"');
    expect(content).toContain('design_entry: "wiki/plans/PLN-0001/design/spec.md"');
    expect(content).toContain('execution_entry: "wiki/plans/PLN-0001/execution/tracker.md"');
    expect(content).toMatch(/created: "\d{4}-\d{2}-\d{2}"/);
    expect(content).not.toMatch(/created: "\d{4}-\d{2}-\d{2}T/);
  });

  it('creates PLN bundle skeleton successfully', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'PLN', title: 'Test plan' });

    expect(result.ok).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/bundle.json')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/design/spec.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/execution/tracker.md')).toBe(true);
    expect(fs.existsSync(path.join(tmp.dir, 'wiki/plans/PLN-0001/source/raw'))).toBe(true);

    const manifest = readJson<PlanBundleManifest>(
      tmp.dir,
      'wiki/plans/PLN-0001/bundle.json',
    );
    expect(manifest.plan_id).toBe('PLN-0001');
    expect(manifest.normalization_version).toBe(1);
    expect(manifest.producer.tool).toBe('manual');
    expect(manifest.entrypoints.design).toBe('design/spec.md');
    expect(manifest.entrypoints.execution).toBe('execution/tracker.md');
    expect(manifest.source_artifacts).toEqual([]);

    expect(readText(tmp.dir, 'wiki/plans/PLN-0001/design/spec.md')).toContain(
      '# PLN-0001 Design',
    );
    expect(readText(tmp.dir, 'wiki/plans/PLN-0001/execution/tracker.md')).toContain(
      '# PLN-0001 Execution',
    );
  });

  it('rejects HO with INVALID_PREFIX error', async () => {
    tmp = await createBootstrappedRepo();
    const result = await create({ dir: tmp.dir, prefix: 'HO', title: 'Test handoff' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_PREFIX');
      expect(result.message).toContain('HO');
    }
  });

  it('created record has correct frontmatter', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'My Task' });

    const content = readText(tmp.dir, 'wiki/issues/WK-0001.md');
    expect(content).toContain('id: "WK-0001"');
    expect(content).toContain('title: "My Task"');
    expect(content).toContain('status: inbox');
    expect(content).toContain('owner: "unassigned"');
    expect(content).toMatch(/created: "\d{4}-\d{2}-\d{2}"/);
    expect(content).not.toMatch(/created: "\d{4}-\d{2}-\d{2}T/);
    expect(content).toMatch(/updated: "\d{4}-\d{2}-\d{2}"/);
    expect(content).not.toMatch(/updated: "\d{4}-\d{2}-\d{2}T/);
  });

  it('created record is written to correct directory', async () => {
    tmp = await createBootstrappedRepo();

    await create({ dir: tmp.dir, prefix: 'WK', title: 'Issue' });
    await create({ dir: tmp.dir, prefix: 'IN', title: 'Initiative' });
    await create({ dir: tmp.dir, prefix: 'DEC', title: 'Decision' });

    expect(fileExists(tmp.dir, 'wiki/issues/WK-0001.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/initiatives/IN-0001.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/decisions/DEC-0001.md')).toBe(true);
  });

  it('every prefix lints clean (0 errors, 0 warnings)', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Issue' });
    await create({ dir: tmp.dir, prefix: 'IN', title: 'Initiative' });
    await create({ dir: tmp.dir, prefix: 'DEC', title: 'Decision' });
    await create({ dir: tmp.dir, prefix: 'SRC', title: 'Source' });
    await create({ dir: tmp.dir, prefix: 'AREA', title: 'Area', slug: 'area-test' });
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Plan' });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.errorCount).toBe(0);
      expect(result.data.warningCount).toBe(0);
    }
  });

  it('WK body contains house sections', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Test issue' });

    const content = readText(tmp.dir, 'wiki/issues/WK-0001.md');
    expect(content).toContain('## Objective');
    expect(content).toContain('## Scope');
    expect(content).toContain('## Checklist');
    expect(content).toContain('## Acceptance criteria');
    expect(content).toContain('## Notes');
  });

  it('IN body contains house sections', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'IN', title: 'Test initiative' });

    const content = readText(tmp.dir, 'wiki/initiatives/IN-0001.md');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Goals');
    expect(content).toContain('## Work Items');
    expect(content).toContain('## Notes');
  });

  it('DEC body contains house sections', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'DEC', title: 'Test decision' });

    const content = readText(tmp.dir, 'wiki/decisions/DEC-0001.md');
    expect(content).toContain('## Context');
    expect(content).toContain('## Decision');
    expect(content).toContain('## Rationale');
    expect(content).toContain('## Consequences');
    expect(content).toContain('## Alternatives Considered');
  });

  it('SRC body contains house sections', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'SRC', title: 'Test source' });

    const content = readText(tmp.dir, 'wiki/sources/SRC-0001.md');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Key Points');
    expect(content).toContain('## Relevance');
    expect(content).toContain('## Notes');
  });

  it('AREA body contains house sections', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'AREA', title: 'Test area', slug: 'test-area' });

    const content = readText(tmp.dir, 'wiki/areas/test-area.md');
    expect(content).toContain('## Overview');
    expect(content).toContain('## Key Initiatives');
    expect(content).toContain('## Key Decisions');
    expect(content).toContain('## Notes');
  });

  it('PLN body contains house sections', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Test plan' });

    const content = readText(tmp.dir, 'wiki/plans/PLN-0001.md');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Scope');
    expect(content).toContain('## Bundle');
    expect(content).toContain('## Emergent Work');
    expect(content).toContain('## Notes');
  });

  it('owner defaults to git user.name in a git repo', async () => {
    tmp = createTmpDir();
    execSync('git init', { cwd: tmp.dir, stdio: 'pipe' });
    execSync('git config user.name "Test Author"', { cwd: tmp.dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmp.dir, stdio: 'pipe' });

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Test' });

    const content = readText(tmp.dir, 'wiki/issues/WK-0001.md');
    expect(content).toContain('owner: "Test Author"');
  });

  it('explicit owner overrides git user.name', async () => {
    tmp = createTmpDir();
    execSync('git init', { cwd: tmp.dir, stdio: 'pipe' });
    execSync('git config user.name "Git User"', { cwd: tmp.dir, stdio: 'pipe' });
    execSync('git config user.email "git@test.com"', { cwd: tmp.dir, stdio: 'pipe' });

    await bootstrap({ dir: tmp.dir, repo: 'test/repo' });
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Test', owner: 'explicit-owner' });

    const content = readText(tmp.dir, 'wiki/issues/WK-0001.md');
    expect(content).toContain('owner: "explicit-owner"');
    expect(content).not.toContain('Git User');
  });

  it('owner falls back to unassigned outside a git repo', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Test' });

    const content = readText(tmp.dir, 'wiki/issues/WK-0001.md');
    expect(content).toContain('owner: "unassigned"');
  });

  it('dates are emitted as date-only YYYY-MM-DD for all types', async () => {
    tmp = await createBootstrappedRepo();

    await create({ dir: tmp.dir, prefix: 'DEC', title: 'Date test' });
    const dec = readText(tmp.dir, 'wiki/decisions/DEC-0001.md');
    expect(dec).toMatch(/date: "\d{4}-\d{2}-\d{2}"/);
    expect(dec).not.toMatch(/date: "\d{4}-\d{2}-\d{2}T/);

    await create({ dir: tmp.dir, prefix: 'SRC', title: 'Date test' });
    const src = readText(tmp.dir, 'wiki/sources/SRC-0001.md');
    expect(src).toMatch(/captured: "\d{4}-\d{2}-\d{2}"/);
    expect(src).not.toMatch(/captured: "\d{4}-\d{2}-\d{2}T/);
    expect(src).toMatch(/updated: "\d{4}-\d{2}-\d{2}"/);
    expect(src).not.toMatch(/updated: "\d{4}-\d{2}-\d{2}T/);

    await create({ dir: tmp.dir, prefix: 'AREA', title: 'Date test', slug: 'date-area' });
    const area = readText(tmp.dir, 'wiki/areas/date-area.md');
    expect(area).toMatch(/updated: "\d{4}-\d{2}-\d{2}"/);
    expect(area).not.toMatch(/updated: "\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Validate Plan Tests
// ---------------------------------------------------------------------------

describe('validatePlan', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('passes on a freshly created PLN bundle', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Valid plan' });

    const result = await validatePlan({ dir: tmp.dir, plan: 'PLN-0001' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.plan).toBe('PLN-0001');
      expect(result.data.valid).toBe(true);
      expect(result.data.issues).toEqual([]);
    }
  });

  it('reports a missing PLN record as invalid', async () => {
    tmp = await createBootstrappedRepo();

    const result = await validatePlan({ dir: tmp.dir, plan: 'PLN-9999' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.valid).toBe(false);
      expect(result.data.issues.map(i => i.code)).toContain('FILE_NOT_FOUND');
    }
  });

  it('rejects entrypoints outside the owning bundle', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Invalid plan' });

    const recordPath = path.join(tmp.dir, 'wiki/plans/PLN-0001.md');
    const original = fs.readFileSync(recordPath, 'utf-8');
    fs.writeFileSync(
      recordPath,
      original.replace(
        'design_entry: "wiki/plans/PLN-0001/design/spec.md"',
        'design_entry: "wiki/plans/PLN-0002/design/spec.md"',
      ),
      'utf-8',
    );

    const result = await validatePlan({ dir: tmp.dir, plan: 'PLN-0001' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.valid).toBe(false);
      expect(result.data.issues.map(i => i.code)).toContain('PATH_OUTSIDE_BUNDLE');
    }
  });

  it('rejects a bundle manifest for a different plan id', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Invalid plan' });

    const manifest = readJson<PlanBundleManifest>(
      tmp.dir,
      'wiki/plans/PLN-0001/bundle.json',
    );
    manifest.plan_id = 'PLN-0002';
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/plans/PLN-0001/bundle.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );

    const result = await validatePlan({ dir: tmp.dir, plan: 'PLN-0001' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.valid).toBe(false);
      expect(result.data.issues.map(i => i.code)).toContain('PLAN_ID_MISMATCH');
    }
  });

  it('rejects source artifacts outside source/raw', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Invalid plan' });

    const manifest = readJson<PlanBundleManifest>(
      tmp.dir,
      'wiki/plans/PLN-0001/bundle.json',
    );
    manifest.source_artifacts = ['design/spec.md'];
    fs.writeFileSync(
      path.join(tmp.dir, 'wiki/plans/PLN-0001/bundle.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );

    const result = await validatePlan({ dir: tmp.dir, plan: 'PLN-0001' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.valid).toBe(false);
      expect(result.data.issues.map(i => i.code)).toContain('PATH_OUTSIDE_SOURCE_RAW');
    }
  });
});

// ---------------------------------------------------------------------------
// Import Plan Tests
// ---------------------------------------------------------------------------

describe('importPlan', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('imports design and execution files into the canonical PLN bundle', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Import plan' });

    fs.mkdirSync(path.join(tmp.dir, 'planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.dir, 'planning/design.md'),
      '# Imported Design\n\nDesign body.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmp.dir, 'planning/execution.md'),
      '# Imported Execution\n\nExecution body.\n',
      'utf-8',
    );

    const result = await importPlan({
      dir: tmp.dir,
      plan: 'PLN-0001',
      design: 'planning/design.md',
      execution: 'planning/execution.md',
      sourceTool: 'superpowers',
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.plan).toBe('PLN-0001');
      expect(result.data.designEntry).toBe('wiki/plans/PLN-0001/design/spec.md');
      expect(result.data.executionEntry).toBe('wiki/plans/PLN-0001/execution/tracker.md');
      expect(result.data.sourceArtifacts).toEqual([
        'source/raw/design-design.md',
        'source/raw/execution-execution.md',
      ]);
    }

    expect(readText(tmp.dir, 'wiki/plans/PLN-0001/design/spec.md')).toContain(
      '# Imported Design',
    );
    expect(readText(tmp.dir, 'wiki/plans/PLN-0001/execution/tracker.md')).toContain(
      '# Imported Execution',
    );
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/source/raw/design-design.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/source/raw/execution-execution.md')).toBe(true);

    const record = readText(tmp.dir, 'wiki/plans/PLN-0001.md');
    expect(record).toContain('status: "packaged"');
    expect(record).toContain('source_tool: "superpowers"');

    const manifest = readJson<PlanBundleManifest>(
      tmp.dir,
      'wiki/plans/PLN-0001/bundle.json',
    );
    expect(manifest.producer.tool).toBe('superpowers');
    expect(manifest.entrypoints.design).toBe('design/spec.md');
    expect(manifest.entrypoints.execution).toBe('execution/tracker.md');
    expect(manifest.source_artifacts).toEqual([
      'source/raw/design-design.md',
      'source/raw/execution-execution.md',
    ]);

    const validation = await validatePlan({ dir: tmp.dir, plan: 'PLN-0001' });
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.data.valid).toBe(true);
    }
  });

  it('refuses to replace canonical bundle files without overwrite', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Import plan' });

    fs.mkdirSync(path.join(tmp.dir, 'planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'planning/design.md'), '# Imported Design\n', 'utf-8');

    const result = await importPlan({
      dir: tmp.dir,
      plan: 'PLN-0001',
      design: 'planning/design.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('IMPORT_ERROR');
    }
  });

  it('imports an execution directory when it provides tracker.md', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Import plan' });

    fs.mkdirSync(path.join(tmp.dir, 'planning/exec/sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'planning/design.md'), '# Imported Design\n', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'planning/exec/tracker.md'), '# Directory Tracker\n', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'planning/exec/sub/task.md'), '# Sub Task\n', 'utf-8');

    const result = await importPlan({
      dir: tmp.dir,
      plan: 'PLN-0001',
      design: 'planning/design.md',
      execution: 'planning/exec',
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    expect(readText(tmp.dir, 'wiki/plans/PLN-0001/execution/tracker.md')).toContain(
      '# Directory Tracker',
    );
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/execution/sub/task.md')).toBe(true);

    const manifest = readJson<PlanBundleManifest>(
      tmp.dir,
      'wiki/plans/PLN-0001/bundle.json',
    );
    expect(manifest.source_artifacts).toContain('source/raw/execution/exec/tracker.md');
    expect(manifest.source_artifacts).toContain('source/raw/execution/exec/sub/task.md');
  });

  it('preserves active plan status during import', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Import plan' });

    const recordPath = path.join(tmp.dir, 'wiki/plans/PLN-0001.md');
    const original = fs.readFileSync(recordPath, 'utf-8');
    fs.writeFileSync(recordPath, original.replace('status: draft', 'status: active'), 'utf-8');

    fs.mkdirSync(path.join(tmp.dir, 'planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'planning/design.md'), '# Imported Design\n', 'utf-8');

    const result = await importPlan({
      dir: tmp.dir,
      plan: 'PLN-0001',
      design: 'planning/design.md',
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    expect(readText(tmp.dir, 'wiki/plans/PLN-0001.md')).toContain('status: "active"');
  });
});

// ---------------------------------------------------------------------------
// Archive Plan Tests
// ---------------------------------------------------------------------------

describe('archivePlan', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('marks a PLN record done without moving the bundle', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Complete plan' });

    const result = await archivePlan({ dir: tmp.dir, plan: 'PLN-0001' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.plan).toBe('PLN-0001');
      expect(result.data.path).toBe('wiki/plans/PLN-0001.md');
      expect(result.data.completed).toBeTruthy();
    }

    const record = readText(tmp.dir, 'wiki/plans/PLN-0001.md');
    expect(record).toContain('status: "done"');
    expect(record).toContain('completed: "');
    expect(record).toContain('updated: "');
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/bundle.json')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/design/spec.md')).toBe(true);
    expect(fileExists(tmp.dir, 'wiki/plans/PLN-0001/execution/tracker.md')).toBe(true);
  });

  it('preserves completed and work_items fields', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Complete plan' });

    const recordPath = path.join(tmp.dir, 'wiki/plans/PLN-0001.md');
    const original = fs.readFileSync(recordPath, 'utf-8');
    const withCompletion = original
      .replace('work_items: []', 'work_items:\n  - "WK-0001"')
      .replace('---\n\n# PLN-0001', 'completed: "2026-05-01T00:00:00.000Z"\n---\n\n# PLN-0001');
    fs.writeFileSync(recordPath, withCompletion, 'utf-8');

    const result = await archivePlan({ dir: tmp.dir, plan: 'PLN-0001' });

    expect(result.ok).toBe(true);
    const record = readText(tmp.dir, 'wiki/plans/PLN-0001.md');
    expect(record).toContain('completed: "2026-05-01T00:00:00.000Z"');
    expect(record).toContain('work_items:');
    expect(record).toContain('  - "WK-0001"');
  });

  it('rejects non-PLN ids', async () => {
    tmp = await createBootstrappedRepo();

    const result = await archivePlan({ dir: tmp.dir, plan: 'WK-0001' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_PREFIX');
    }
  });

  it('rejects missing PLN records', async () => {
    tmp = await createBootstrappedRepo();

    const result = await archivePlan({ dir: tmp.dir, plan: 'PLN-9999' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('FILE_NOT_FOUND');
    }
  });
});

// ---------------------------------------------------------------------------
// Lint Tests
// ---------------------------------------------------------------------------

describe('lint', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('passes on valid records', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Valid item' });
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Valid plan' });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.errorCount).toBe(0);
    }
  });

  it('detects missing required fields', async () => {
    tmp = await createBootstrappedRepo();

    // Write a record with missing required fields
    writeRecord(tmp.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'Test',
      // missing: type, status, priority, owner, created, updated
    });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const missing = result.data.diagnostics.filter(d => d.code === 'MISSING_FIELD');
      expect(missing.length).toBeGreaterThan(0);
    }
  });

  it('detects invalid enum values', async () => {
    tmp = await createBootstrappedRepo();

    writeRecord(tmp.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'Test',
      type: 'invalid_type',
      status: 'inbox',
      priority: 'medium',
      owner: 'test',
      created: '2025-01-01',
      updated: '2025-01-01',
    });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const invalidEnum = result.data.diagnostics.filter(d => d.code === 'INVALID_ENUM');
      expect(invalidEnum.length).toBeGreaterThan(0);
    }
  });

  it('detects duplicate IDs', async () => {
    tmp = await createBootstrappedRepo();

    // Create two records with the same ID
    writeRecord(tmp.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'First',
      type: 'task',
      status: 'inbox',
      priority: 'medium',
      owner: 'test',
      created: '2025-01-01',
      updated: '2025-01-01',
    });
    writeRecord(tmp.dir, 'wiki/issues/WK-0002.md', {
      id: 'WK-0001', // duplicate!
      title: 'Second',
      type: 'task',
      status: 'inbox',
      priority: 'medium',
      owner: 'test',
      created: '2025-01-01',
      updated: '2025-01-01',
    });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const dupes = result.data.diagnostics.filter(d => d.code === 'DUPLICATE_ID');
      expect(dupes.length).toBeGreaterThan(0);
    }
  });

  it('detects broken record references', async () => {
    tmp = await createBootstrappedRepo();

    writeRecord(tmp.dir, 'wiki/issues/WK-0001.md', {
      id: 'WK-0001',
      title: 'Test',
      type: 'task',
      status: 'inbox',
      priority: 'medium',
      owner: 'test',
      created: '2025-01-01',
      updated: '2025-01-01',
      depends_on: ['WK-9999'], // does not exist
    });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const broken = result.data.diagnostics.filter(d => d.code === 'BROKEN_REFERENCE');
      expect(broken.length).toBeGreaterThan(0);
    }
  });

  it('warns on closed records with unchecked checklists', async () => {
    tmp = await createBootstrappedRepo();

    writeRecord(
      tmp.dir,
      'wiki/issues/WK-0001.md',
      {
        id: 'WK-0001',
        title: 'Done item',
        type: 'task',
        status: 'done',
        priority: 'medium',
        owner: 'test',
        created: '2025-01-01',
        updated: '2025-01-01',
      },
      '# WK-0001\n\n- [ ] unchecked item\n',
    );

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const warnings = result.data.diagnostics.filter(
        d => d.code === 'UNCHECKED_CHECKLIST' && d.severity === 'warning',
      );
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  it('excludes generated views', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Real item' });

    // Generate views (which create files with _generated: true)
    await generate({ dir: tmp.dir });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Generated views should not be counted as linted files
      const lintedPaths = result.data.diagnostics.map(d => d.file);
      for (const view of ['wiki/catalog.md', 'wiki/now.md', 'wiki/inbox.md', 'wiki/backlog.md', 'wiki/archive.md']) {
        expect(lintedPaths).not.toContain(view);
      }
    }
  });

  it('excludes wiki/handoffs/', async () => {
    tmp = await createBootstrappedRepo();

    // Place a file in wiki/handoffs/
    writeRecord(tmp.dir, 'wiki/handoffs/HO-0001.md', {
      id: 'HO-0001',
      title: 'Handoff',
      status: 'open',
    });

    const result = await lint({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Handoff file should not appear in diagnostics
      const handoffDiags = result.data.diagnostics.filter(d =>
        d.file.includes('handoffs'),
      );
      expect(handoffDiags.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Generate Tests
// ---------------------------------------------------------------------------

describe('generate', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('creates all 5 views (catalog, now, inbox, backlog, archive)', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Test item' });

    const result = await generate({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.generated).toContain('wiki/catalog.md');
      expect(result.data.generated).toContain('wiki/now.md');
      expect(result.data.generated).toContain('wiki/inbox.md');
      expect(result.data.generated).toContain('wiki/backlog.md');
      expect(result.data.generated).toContain('wiki/archive.md');
      expect(result.data.generated.length).toBe(5);
    }
  });

  it('generated views have generated frontmatter marker', async () => {
    tmp = await createBootstrappedRepo();
    await generate({ dir: tmp.dir });

    const views = ['catalog.md', 'now.md', 'inbox.md', 'backlog.md', 'archive.md'];
    for (const view of views) {
      const content = readText(tmp.dir, `wiki/${view}`);
      expect(content).toContain('_generated: true');
    }
  });

  it('generates file-relative links in view files', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Test item' });

    await generate({ dir: tmp.dir });

    const catalog = readText(tmp.dir, 'wiki/catalog.md');
    expect(catalog).toContain('[WK-0001](issues/WK-0001.md)');
    expect(catalog).not.toContain('[WK-0001](wiki/issues/WK-0001.md)');
  });

  it('excludes wiki/handoffs/ content', async () => {
    tmp = await createBootstrappedRepo();

    // Place a handoff record in wiki/handoffs/
    writeRecord(tmp.dir, 'wiki/handoffs/HO-0001.md', {
      id: 'HO-0001',
      title: 'Some handoff',
      status: 'in_progress',
    });

    // Also create a real record
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Real item' });

    await generate({ dir: tmp.dir });

    // Handoff should not appear in any generated views
    const catalog = readText(tmp.dir, 'wiki/catalog.md');
    expect(catalog).not.toContain('HO-0001');

    const now = readText(tmp.dir, 'wiki/now.md');
    expect(now).not.toContain('HO-0001');
  });

  it('organizes records by status correctly', async () => {
    tmp = await createBootstrappedRepo();

    // Create records with different statuses
    // inbox status -> should appear in inbox view
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Inbox item' });
    // Modify the second record to be in_progress
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Active item' });
    const activePath = path.join(tmp.dir, 'wiki/issues/WK-0002.md');
    let activeContent = fs.readFileSync(activePath, 'utf-8');
    activeContent = activeContent.replace('status: inbox', 'status: in_progress');
    fs.writeFileSync(activePath, activeContent, 'utf-8');

    await generate({ dir: tmp.dir });

    const inbox = readText(tmp.dir, 'wiki/inbox.md');
    expect(inbox).toContain('WK-0001');

    const now = readText(tmp.dir, 'wiki/now.md');
    expect(now).toContain('WK-0002');
  });

  it('includes PLN records in catalog but excludes them from work-tracking views', async () => {
    tmp = await createBootstrappedRepo();

    writeRecord(tmp.dir, 'wiki/plans/PLN-0001.md', {
      id: 'PLN-0001',
      title: 'Active plan',
      status: 'active',
      owner: 'test',
      created: '2025-01-01',
      updated: '2025-01-01',
    });
    writeRecord(tmp.dir, 'wiki/plans/PLN-0002.md', {
      id: 'PLN-0002',
      title: 'Done plan',
      status: 'done',
      owner: 'test',
      created: '2025-01-01',
      updated: '2025-01-01',
    });

    await generate({ dir: tmp.dir });

    const catalog = readText(tmp.dir, 'wiki/catalog.md');
    expect(catalog).toContain('PLN-0001');
    expect(catalog).toContain('PLN-0002');

    for (const view of ['now.md', 'inbox.md', 'backlog.md', 'archive.md']) {
      const content = readText(tmp.dir, `wiki/${view}`);
      expect(content).not.toContain('PLN-0001');
      expect(content).not.toContain('PLN-0002');
    }
  });
});

// ---------------------------------------------------------------------------
// Search Tests
// ---------------------------------------------------------------------------

describe('search', () => {
  let tmp: TmpRepo;

  afterEach(() => {
    tmp?.cleanup();
  });

  it('build index includes manifest-driven records', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Searchable issue' });
    await create({ dir: tmp.dir, prefix: 'IN', title: 'Searchable initiative' });
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Searchable plan' });

    const result = await buildSearchIndex({ dir: tmp.dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.indexed).toBeGreaterThanOrEqual(2);
    }

    // Verify the index file contains the records
    const index = readJson<{ entries: Array<{ id: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const ids = index.entries.map(e => e.id);
    expect(ids).toContain('WK-0001');
    expect(ids).toContain('IN-0001');
    expect(ids).toContain('PLN-0001');
  });

  it('build index includes PLN records but excludes PLN bundle internals', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'PLN', title: 'Plan with bundle' });

    const bundleDir = path.join(tmp.dir, 'wiki/plans/PLN-0001/design');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, 'spec.md'),
      '# Bundle Spec\n\nThis internal bundle file should not be indexed.\n',
      'utf-8',
    );

    await buildSearchIndex({ dir: tmp.dir });

    const index = readJson<{ entries: Array<{ id: string; path: string }> }>(
      tmp.dir,
      'wiki/.search-index.json',
    );
    const paths = index.entries.map(e => e.path);
    expect(paths).toContain('wiki/plans/PLN-0001.md');
    expect(paths).not.toContain('wiki/plans/PLN-0001/design/spec.md');
  });

  it('build index includes docs/**/*.md', async () => {
    tmp = await createBootstrappedRepo();

    // Create a doc file
    fs.mkdirSync(path.join(tmp.dir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.dir, 'docs/guide.md'),
      '# Getting Started\n\nThis is a guide about the project.\n',
      'utf-8',
    );

    const result = await buildSearchIndex({ dir: tmp.dir });
    expect(result.ok).toBe(true);

    const index = readJson<{ entries: Array<{ path: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const paths = index.entries.map(e => e.path);
    expect(paths).toContain('docs/guide.md');
  });

  it('build index includes root README.md, AGENTS.md, CLAUDE.md', async () => {
    tmp = await createBootstrappedRepo();

    fs.writeFileSync(path.join(tmp.dir, 'README.md'), '# My Project\n\nReadme content.\n', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'AGENTS.md'), '# Agents\n\nAgent rules.\n', 'utf-8');
    fs.writeFileSync(path.join(tmp.dir, 'CLAUDE.md'), '# Claude\n\nClaude config.\n', 'utf-8');

    const result = await buildSearchIndex({ dir: tmp.dir });
    expect(result.ok).toBe(true);

    const index = readJson<{ entries: Array<{ path: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const paths = index.entries.map(e => e.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CLAUDE.md');
  });

  it('build index excludes generated views', async () => {
    tmp = await createBootstrappedRepo();
    await create({ dir: tmp.dir, prefix: 'WK', title: 'An item' });
    await generate({ dir: tmp.dir });

    const result = await buildSearchIndex({ dir: tmp.dir });
    expect(result.ok).toBe(true);

    const index = readJson<{ entries: Array<{ path: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const paths = index.entries.map(e => e.path);

    // Generated views should not be in the index
    expect(paths).not.toContain('wiki/catalog.md');
    expect(paths).not.toContain('wiki/now.md');
    expect(paths).not.toContain('wiki/inbox.md');
    expect(paths).not.toContain('wiki/backlog.md');
    expect(paths).not.toContain('wiki/archive.md');
  });

  it('build index excludes wiki/handoffs/', async () => {
    tmp = await createBootstrappedRepo();

    // Place a handoff file
    writeRecord(tmp.dir, 'wiki/handoffs/HO-0001.md', {
      id: 'HO-0001',
      title: 'A handoff',
      status: 'pending',
    });

    await buildSearchIndex({ dir: tmp.dir });

    const index = readJson<{ entries: Array<{ path: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const paths = index.entries.map(e => e.path);
    const handoffPaths = paths.filter(p => p.includes('handoffs'));
    expect(handoffPaths.length).toBe(0);
  });

  it('build index excludes .agent-runs/, scratch_space/, node_modules/, dist/', async () => {
    tmp = await createBootstrappedRepo();

    // Create files in excluded directories under docs/ to test recursive exclusion
    const excludedDirs = ['.agent-runs', 'scratch_space', 'node_modules', 'dist'];
    for (const dir of excludedDirs) {
      const dirPath = path.join(tmp.dir, 'docs', dir);
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, 'should-not-index.md'), '# Excluded\n', 'utf-8');
    }

    // Also create a legitimate doc
    fs.writeFileSync(
      path.join(tmp.dir, 'docs/included.md'),
      '# Included\n\nThis should be in the index.\n',
      'utf-8',
    );

    await buildSearchIndex({ dir: tmp.dir });

    const index = readJson<{ entries: Array<{ path: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const paths = index.entries.map(e => e.path);

    expect(paths).toContain('docs/included.md');
    for (const dir of excludedDirs) {
      const excluded = paths.filter(p => p.includes(dir));
      expect(excluded.length, `Expected no files from ${dir}`).toBe(0);
    }
  });

  it('build index excludes docs/superpowers/specs/ and docs/superpowers/plans/', async () => {
    tmp = await createBootstrappedRepo();

    fs.mkdirSync(path.join(tmp.dir, 'docs', 'superpowers', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(tmp.dir, 'docs', 'superpowers', 'plans'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.dir, 'docs', 'superpowers', 'specs', 'pln-design.md'),
      '# PLN Design\n\nPlanning-only design material.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmp.dir, 'docs', 'superpowers', 'plans', 'pln-plan.md'),
      '# PLN Plan\n\nPlanning-only implementation plan.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmp.dir, 'docs', 'reference.md'),
      '# Reference\n\nDurable operator documentation.\n',
      'utf-8',
    );

    await buildSearchIndex({ dir: tmp.dir });

    const index = readJson<{ entries: Array<{ path: string }> }>(tmp.dir, 'wiki/.search-index.json');
    const paths = index.entries.map(e => e.path);

    expect(paths).toContain('docs/reference.md');
    expect(paths).not.toContain('docs/superpowers/specs/pln-design.md');
    expect(paths).not.toContain('docs/superpowers/plans/pln-plan.md');
  });

  it('search returns relevant results for query', async () => {
    tmp = await createBootstrappedRepo();

    // Create records with distinct content
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Fix the database migration' });
    await create({ dir: tmp.dir, prefix: 'WK', title: 'Update user interface' });

    await buildSearchIndex({ dir: tmp.dir });

    const result = await search({ dir: tmp.dir, query: 'database migration' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hits.length).toBeGreaterThan(0);
      // The database-related item should rank first
      expect(result.data.hits[0].title).toContain('database');
    }
  });

  it('search supports prefix filter', async () => {
    tmp = await createBootstrappedRepo();

    await create({ dir: tmp.dir, prefix: 'WK', title: 'Work task about widgets' });
    await create({ dir: tmp.dir, prefix: 'IN', title: 'Initiative about widgets' });

    await buildSearchIndex({ dir: tmp.dir });

    const result = await search({ dir: tmp.dir, query: 'widgets', prefix: 'WK' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hits.length).toBeGreaterThan(0);
      for (const hit of result.data.hits) {
        expect(hit.prefix).toBe('WK');
      }
    }
  });

  it('search refreshes a stale index before applying status filters', async () => {
    tmp = await createBootstrappedRepo();

    const created = await create({ dir: tmp.dir, prefix: 'WK', title: 'Fix parser bug' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const recordPath = path.join(tmp.dir, created.data.path);
    const original = fs.readFileSync(recordPath, 'utf-8');
    const inProgress = original.replace('status: inbox', 'status: in_progress');
    fs.writeFileSync(recordPath, inProgress, 'utf-8');

    await buildSearchIndex({ dir: tmp.dir });

    const done = inProgress.replace('status: in_progress', 'status: done');
    fs.writeFileSync(recordPath, done, 'utf-8');

    const result = await search({ dir: tmp.dir, query: 'parser', status: 'in_progress' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hits).toHaveLength(0);
    }
  });
});
