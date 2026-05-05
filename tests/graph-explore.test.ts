import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildGraph,
  writeGraphJson,
  writeGraphSummary,
  generateSummary,
  scanDirectory,
  classifyFile,
  isExcluded,
  extractImports,
  extractAllImports,
  resolveTsImport,
  resolvePyImport,
  extractWikiEdges,
  extractAllWikiEdges,
  extractMarkdownLinks,
  parseRecord,
} from '../packages/graph-explore/src/index.js';
import type { GraphExport } from '../packages/graph-explore/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THIS_DIR = path.resolve(process.cwd(), 'tests');
const FIXTURE_DIR = path.resolve(THIS_DIR, 'fixtures', 'sample-repo');

/** Create a temporary directory with specific files for isolated tests. */
function createTmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-graph-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/** Write a file inside a directory, creating parent dirs as needed. */
function writeFile(base: string, relPath: string, content: string): void {
  const absPath = path.join(base, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('graph-explore', () => {
  // =========================================================================
  // 1. JS/TS import extraction
  // =========================================================================
  describe('JS/TS import extraction', () => {
    it('extracts imports edges from import/export/require statements', () => {
      const edges = extractImports('src/index.ts', FIXTURE_DIR);

      // src/index.ts imports from ./utils/helper.js and ./utils/math.js
      const targets = edges.map(e => e.target);
      expect(targets).toContain('src/utils/helper.ts');
      expect(targets).toContain('src/utils/math.ts');
      expect(edges.every(e => e.relation === 'imports')).toBe(true);
      expect(edges.every(e => e.source === 'src/index.ts')).toBe(true);
    });

    it('extracts require() calls from JS files', () => {
      const edges = extractImports('src/app.js', FIXTURE_DIR);

      // app.js requires ./index (resolves to src/index.ts)
      const targets = edges.map(e => e.target);
      expect(targets).toContain('src/index.ts');
      // express is external, should not appear
      expect(targets.every(t => !t.includes('express'))).toBe(true);
    });

    it('extracts re-export edges', () => {
      const edges = extractImports('src/reexport.ts', FIXTURE_DIR);

      const targets = edges.map(e => e.target);
      expect(targets).toContain('src/utils/helper.ts');
      expect(targets).toContain('src/utils/math.ts');
    });
  });

  // =========================================================================
  // 2. Python import extraction
  // =========================================================================
  describe('Python import extraction', () => {
    it('extracts imports edges from Python import/from-import', () => {
      const edges = extractImports('scripts/analyze.py', FIXTURE_DIR);

      // from lib import processor -> resolves to lib/processor.py
      const targets = edges.map(e => e.target);
      expect(targets).toContain('lib/processor.py');
      expect(edges.every(e => e.relation === 'imports')).toBe(true);
    });

    it('ignores stdlib Python imports', () => {
      const edges = extractImports('scripts/analyze.py', FIXTURE_DIR);

      // os and json are stdlib, should not appear
      const targets = edges.map(e => e.target);
      expect(targets.every(t => t !== 'os.py' && t !== 'json.py')).toBe(true);
    });
  });

  // =========================================================================
  // 3. Repo-local resolution (external modules ignored)
  // =========================================================================
  describe('repo-local resolution', () => {
    it('ignores external npm packages', () => {
      const edges = extractImports('src/app.js', FIXTURE_DIR);
      const targets = edges.map(e => e.target);
      // express should not appear
      expect(targets).not.toContain('express');
      expect(targets.every(t => !t.includes('node_modules'))).toBe(true);
    });

    it('resolves relative imports with extension mapping', () => {
      // ./utils/helper.js -> resolves to src/utils/helper.ts
      const resolved = resolveTsImport('./utils/helper.js', 'src/index.ts', FIXTURE_DIR);
      expect(resolved).toBe('src/utils/helper.ts');
    });
  });

  // =========================================================================
  // 4. Wiki overlay extraction
  // =========================================================================
  describe('wiki overlay extraction', () => {
    it('extracts correct edges from frontmatter fields', () => {
      const edges = extractWikiEdges('wiki/issues/WK-0001.md', FIXTURE_DIR);

      // repo_paths -> repo_path edges
      const repoPathEdges = edges.filter(e => e.relation === 'repo_path');
      expect(repoPathEdges.map(e => e.target)).toContain('src/index.ts');
      expect(repoPathEdges.map(e => e.target)).toContain('src/utils/helper.ts');

      // docs -> doc edges
      const docEdges = edges.filter(e => e.relation === 'doc');
      expect(docEdges.map(e => e.target)).toContain('docs/guide.md');

      // depends_on edges
      const dependsEdges = edges.filter(e => e.relation === 'depends_on');
      expect(dependsEdges.map(e => e.target)).toContain('WK-0002');

      // area edge
      const areaEdges = edges.filter(e => e.relation === 'area');
      expect(areaEdges.map(e => e.target)).toContain('core');

      // All edges should have the correct source
      expect(edges.every(e => e.source === 'wiki/issues/WK-0001.md')).toBe(true);
    });

    it('extracts blocks and initiative edges', () => {
      const edges = extractWikiEdges('wiki/issues/WK-0002.md', FIXTURE_DIR);

      const blocksEdges = edges.filter(e => e.relation === 'blocks');
      expect(blocksEdges.map(e => e.target)).toContain('WK-0001');

      const initiativeEdges = edges.filter(e => e.relation === 'initiative');
      expect(initiativeEdges.map(e => e.target)).toContain('IN-0001');

      const relatedEdges = edges.filter(e => e.relation === 'related');
      expect(relatedEdges.map(e => e.target)).toContain('IN-0001');
    });
  });

  // =========================================================================
  // 5. Markdown link extraction
  // =========================================================================
  describe('markdown link extraction', () => {
    it('extracts markdown_link edges from wiki record bodies', () => {
      const edges = extractWikiEdges('wiki/issues/WK-0001.md', FIXTURE_DIR);

      const mdLinks = edges.filter(e => e.relation === 'markdown_link');
      const targets = mdLinks.map(e => e.target);

      // Should have local link to ../../src/utils/math.ts
      expect(targets).toContain('../../src/utils/math.ts');
      // Should NOT have external links
      expect(targets.every(t => !t.startsWith('http'))).toBe(true);
    });

    it('extractMarkdownLinks skips external URLs and anchors', () => {
      const links = extractMarkdownLinks(
        'See [docs](docs/api.md) and [external](https://example.com) and [anchor](#section).'
      );
      expect(links).toEqual(['docs/api.md']);
    });
  });

  // =========================================================================
  // 6. Excluded path handling
  // =========================================================================
  describe('excluded path handling', () => {
    it('excludes node_modules from scanning', () => {
      expect(isExcluded('node_modules/foo/index.js')).toBe(true);
    });

    it('excludes .agent-runs from scanning', () => {
      expect(isExcluded('.agent-runs/test.json')).toBe(true);
    });

    it('excludes scratch_space from scanning', () => {
      expect(isExcluded('scratch_space/plans/test.md')).toBe(true);
    });

    it('excludes dist from scanning', () => {
      expect(isExcluded('dist/index.js')).toBe(true);
    });

    it('excludes generated views', () => {
      expect(isExcluded('wiki/catalog.md')).toBe(true);
      expect(isExcluded('wiki/now.md')).toBe(true);
      expect(isExcluded('wiki/inbox.md')).toBe(true);
      expect(isExcluded('wiki/backlog.md')).toBe(true);
      expect(isExcluded('wiki/archive.md')).toBe(true);
    });

    it('does not exclude valid code and doc files', () => {
      expect(isExcluded('src/index.ts')).toBe(false);
      expect(isExcluded('docs/guide.md')).toBe(false);
      expect(isExcluded('wiki/issues/WK-0001.md')).toBe(false);
    });

    it('nodes in excluded directories are not in scanned results', () => {
      const nodes = scanDirectory(FIXTURE_DIR);
      const nodeIds = nodes.map(n => n.id);

      // Excluded paths should not appear
      expect(nodeIds.every(id => !id.startsWith('node_modules/'))).toBe(true);
      expect(nodeIds.every(id => !id.startsWith('.agent-runs/'))).toBe(true);
      expect(nodeIds.every(id => !id.startsWith('wiki/handoffs/'))).toBe(true);

      // Generated views should not appear
      expect(nodeIds).not.toContain('wiki/catalog.md');
    });

    it('includes supported files in non-excluded dot-directories', () => {
      const tmp = createTmpDir();
      try {
        writeFile(tmp.dir, '.github/workflows/ci.yml', 'name: CI\n');

        const nodes = scanDirectory(tmp.dir);
        const nodeIds = nodes.map(n => n.id);

        expect(nodeIds).toContain('.github/workflows/ci.yml');
      } finally {
        tmp.cleanup();
      }
    });
  });

  // =========================================================================
  // 7. Handoff exclusion
  // =========================================================================
  describe('handoff exclusion', () => {
    it('excludes wiki/handoffs/ content from scanning', () => {
      expect(isExcluded('wiki/handoffs/HO-0001.md')).toBe(true);

      const nodes = scanDirectory(FIXTURE_DIR);
      const nodeIds = nodes.map(n => n.id);
      expect(nodeIds.every(id => !id.startsWith('wiki/handoffs/'))).toBe(true);
    });

    it('does not include HO-* records in the graph', () => {
      const graph = buildGraph(FIXTURE_DIR);
      const nodeIds = graph.nodes.map(n => n.id);
      expect(nodeIds.every(id => !id.includes('HO-'))).toBe(true);
    });
  });

  // =========================================================================
  // 8. Missing node handling
  // =========================================================================
  describe('missing node handling', () => {
    it('referenced but non-existent files get exists: false', () => {
      const graph = buildGraph(FIXTURE_DIR);

      // WK-0001 depends_on WK-0002 (the string "WK-0002"), which is
      // not a file path the scanner would find — it gets exists: false
      const wk0002Ref = graph.nodes.find(n => n.id === 'WK-0002');
      expect(wk0002Ref).toBeDefined();
      expect(wk0002Ref!.exists).toBe(false);
    });

    it('scanned existing files have exists: true', () => {
      const graph = buildGraph(FIXTURE_DIR);

      const indexNode = graph.nodes.find(n => n.id === 'src/index.ts');
      expect(indexNode).toBeDefined();
      expect(indexNode!.exists).toBe(true);
      expect(indexNode!.kind).toBe('code_file');
    });
  });

  // =========================================================================
  // 9. Orphan calculation
  // =========================================================================
  describe('orphan calculation', () => {
    it('nodes with no edges are correctly identified as orphans', () => {
      const graph = buildGraph(FIXTURE_DIR);

      // src/orphan.ts has no imports and is not referenced anywhere
      expect(graph.orphans).toContain('src/orphan.ts');

      // src/index.ts is connected (it imports things, and app.js requires it)
      expect(graph.orphans).not.toContain('src/index.ts');
    });

    it('orphans list is sorted', () => {
      const graph = buildGraph(FIXTURE_DIR);
      const sorted = [...graph.orphans].sort();
      expect(graph.orphans).toEqual(sorted);
    });
  });

  // =========================================================================
  // 10. JSON export
  // =========================================================================
  describe('JSON export', () => {
    let tmpDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      const tmp = createTmpDir();
      tmpDir = tmp.dir;
      cleanup = tmp.cleanup;

      // Copy the fixture to tmp so we can write output without modifying fixtures
      copyDirRecursive(FIXTURE_DIR, tmpDir);
    });

    afterAll(() => {
      cleanup();
    });

    it('output matches GraphExport schema', () => {
      const graph = buildGraph(tmpDir);
      writeGraphJson(tmpDir, graph);

      const jsonPath = path.join(tmpDir, 'wiki', '.graph.json');
      expect(fs.existsSync(jsonPath)).toBe(true);

      const loaded: GraphExport = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

      // Verify required fields
      expect(typeof loaded.generated_at).toBe('string');
      expect(Array.isArray(loaded.nodes)).toBe(true);
      expect(Array.isArray(loaded.edges)).toBe(true);
      expect(Array.isArray(loaded.orphans)).toBe(true);

      // Verify node shape
      for (const node of loaded.nodes) {
        expect(typeof node.id).toBe('string');
        expect(['code_file', 'doc_file', 'wiki_record']).toContain(node.kind);
        expect(typeof node.exists).toBe('boolean');
      }

      // Verify edge shape
      for (const edge of loaded.edges) {
        expect(typeof edge.source).toBe('string');
        expect(typeof edge.target).toBe('string');
        expect([
          'imports', 'repo_path', 'doc', 'depends_on', 'blocks',
          'related', 'area', 'initiative', 'markdown_link',
        ]).toContain(edge.relation);
      }
    });
  });

  // =========================================================================
  // 11. Markdown summary export
  // =========================================================================
  describe('markdown summary export', () => {
    let tmpDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      const tmp = createTmpDir();
      tmpDir = tmp.dir;
      cleanup = tmp.cleanup;
      copyDirRecursive(FIXTURE_DIR, tmpDir);
    });

    afterAll(() => {
      cleanup();
    });

    it('summary contains required sections', () => {
      const graph = buildGraph(tmpDir);
      const summary = generateSummary(graph);

      // Required sections
      expect(summary).toContain('# Graph Summary');
      expect(summary).toContain('## Overview');
      expect(summary).toContain('**Total nodes:**');
      expect(summary).toContain('**Total edges:**');
      expect(summary).toContain('## Nodes by Kind');
      expect(summary).toContain('**code_file:**');
      expect(summary).toContain('**doc_file:**');
      expect(summary).toContain('**wiki_record:**');
      expect(summary).toContain('## Edges by Relation');
      expect(summary).toContain('## Orphan Nodes');
      expect(summary).toContain('## Missing Referenced Nodes');
      expect(summary).toContain('## Highest In-Degree Nodes');
    });

    it('writes summary file to wiki/graph-summary.md', () => {
      const graph = buildGraph(tmpDir);
      writeGraphSummary(tmpDir, graph);

      const summaryPath = path.join(tmpDir, 'wiki', 'graph-summary.md');
      expect(fs.existsSync(summaryPath)).toBe(true);

      const content = fs.readFileSync(summaryPath, 'utf-8');
      expect(content).toContain('# Graph Summary');
    });
  });

  // =========================================================================
  // 12. Determinism
  // =========================================================================
  describe('determinism', () => {
    it('running extraction twice produces identical output', () => {
      const graph1 = buildGraph(FIXTURE_DIR);
      const graph2 = buildGraph(FIXTURE_DIR);

      // Normalize generated_at for comparison
      graph1.generated_at = 'fixed';
      graph2.generated_at = 'fixed';

      expect(JSON.stringify(graph1)).toBe(JSON.stringify(graph2));
    });
  });

  // =========================================================================
  // Node classification
  // =========================================================================
  describe('node classification', () => {
    it('classifies TS files as code_file', () => {
      const node = classifyFile('src/index.ts');
      expect(node).not.toBeNull();
      expect(node!.kind).toBe('code_file');
    });

    it('classifies doc files as doc_file', () => {
      const node = classifyFile('docs/guide.md');
      expect(node).not.toBeNull();
      expect(node!.kind).toBe('doc_file');
    });

    it('classifies wiki records correctly', () => {
      const node = classifyFile('wiki/issues/WK-0001.md');
      expect(node).not.toBeNull();
      expect(node!.kind).toBe('wiki_record');
      expect(node!.prefix).toBe('WK');
    });

    it('returns null for excluded paths', () => {
      expect(classifyFile('node_modules/foo.js')).toBeNull();
      expect(classifyFile('wiki/catalog.md')).toBeNull();
      expect(classifyFile('wiki/handoffs/HO-0001.md')).toBeNull();
    });
  });

  // =========================================================================
  // Frontmatter parsing
  // =========================================================================
  describe('frontmatter parsing', () => {
    it('parses simple key-value pairs', () => {
      const { frontmatter } = parseRecord('---\nid: "WK-0001"\ntitle: "Test"\n---\nBody.');
      expect(frontmatter['id']).toBe('WK-0001');
      expect(frontmatter['title']).toBe('Test');
    });

    it('parses array fields', () => {
      const content = '---\nrepo_paths:\n  - "src/a.ts"\n  - "src/b.ts"\n---\n';
      const { frontmatter } = parseRecord(content);
      expect(frontmatter['repo_paths']).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('returns body content after frontmatter', () => {
      const { body } = parseRecord('---\nid: "test"\n---\n\nBody content here.');
      expect(body).toBe('Body content here.');
    });
  });
});

// ---------------------------------------------------------------------------
// Utility: recursive directory copy
// ---------------------------------------------------------------------------
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
