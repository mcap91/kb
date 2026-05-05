/**
 * Core graph construction logic.
 *
 * Orchestrates scanning, code extraction, wiki overlay, and produces
 * the final GraphExport object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphNode, GraphEdge, GraphExport, EdgeRelation } from './types.js';
import { scanDirectory } from './scan.js';
import { extractAllImports } from './code-extract.js';
import { extractAllWikiEdges } from './wiki-overlay.js';

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

/**
 * Build the full graph export for a target repository.
 */
export function buildGraph(repoRoot: string): GraphExport {
  // 1. Scan for nodes
  const scannedNodes = scanDirectory(repoRoot);

  // Build a map for quick lookup
  const nodeMap = new Map<string, GraphNode>();
  for (const node of scannedNodes) {
    nodeMap.set(node.id, node);
  }

  // 2. Extract code import edges
  const codeFiles = scannedNodes
    .filter(n => n.kind === 'code_file')
    .map(n => n.id);
  const importEdges = extractAllImports(codeFiles, repoRoot);

  // 3. Extract wiki overlay edges
  const wikiRecords = scannedNodes
    .filter(n => n.kind === 'wiki_record')
    .map(n => n.id);
  const wikiEdges = extractAllWikiEdges(wikiRecords, repoRoot);

  // 4. Combine all edges
  const allEdges = [...importEdges, ...wikiEdges];

  // 5. Add missing referenced nodes (exists: false)
  for (const edge of allEdges) {
    for (const id of [edge.source, edge.target]) {
      if (!nodeMap.has(id)) {
        const node = inferNodeKind(id);
        nodeMap.set(id, node);
      }
    }
  }

  // 6. Compute orphans (nodes with zero incident edges)
  const connectedNodes = new Set<string>();
  for (const edge of allEdges) {
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  }

  const orphans: string[] = [];
  for (const [id] of nodeMap) {
    if (!connectedNodes.has(id)) {
      orphans.push(id);
    }
  }
  orphans.sort();

  // 7. Sort nodes and edges for determinism
  const nodes = Array.from(nodeMap.values());
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  allEdges.sort((a, b) =>
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target) ||
    a.relation.localeCompare(b.relation)
  );

  return {
    generated_at: new Date().toISOString(),
    nodes,
    edges: allEdges,
    orphans,
  };
}

/**
 * Infer node kind from a path that was referenced but not found during scanning.
 */
function inferNodeKind(id: string): GraphNode {
  const normalized = id.replace(/\\/g, '/');

  // Check if it looks like a wiki record ID (e.g. WK-0001, IN-0001)
  if (/^(WK|IN|DEC|SRC)-\d+$/.test(normalized) || /^AREA-/.test(normalized)) {
    const prefix = normalized.split('-')[0] as GraphNode['prefix'];
    return { id: normalized, kind: 'wiki_record', prefix, exists: false };
  }

  // Check if it's in a wiki record directory
  const wikiDirs = ['wiki/issues/', 'wiki/initiatives/', 'wiki/decisions/', 'wiki/sources/', 'wiki/areas/'];
  for (const dir of wikiDirs) {
    if (normalized.startsWith(dir) && normalized.endsWith('.md')) {
      const prefixMap: Record<string, GraphNode['prefix']> = {
        'wiki/issues/': 'WK',
        'wiki/initiatives/': 'IN',
        'wiki/decisions/': 'DEC',
        'wiki/sources/': 'SRC',
        'wiki/areas/': 'AREA',
      };
      return { id: normalized, kind: 'wiki_record', prefix: prefixMap[dir], exists: false };
    }
  }

  // Check doc-like paths
  if (normalized.endsWith('.md') || normalized.endsWith('.txt') || normalized.endsWith('.rst')) {
    return { id: normalized, kind: 'doc_file', exists: false };
  }

  // Default to code file
  return { id: normalized, kind: 'code_file', exists: false };
}

// ---------------------------------------------------------------------------
// Export functions
// ---------------------------------------------------------------------------

/**
 * Write the graph export as JSON to wiki/.graph.json in the target repo.
 */
export function writeGraphJson(repoRoot: string, graph: GraphExport): string {
  const wikiDir = path.join(repoRoot, 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  const outputPath = path.join(wikiDir, '.graph.json');
  fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  return outputPath;
}

/**
 * Generate and write the graph summary markdown to wiki/graph-summary.md.
 */
export function writeGraphSummary(repoRoot: string, graph: GraphExport): string {
  const wikiDir = path.join(repoRoot, 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  const outputPath = path.join(wikiDir, 'graph-summary.md');

  const summary = generateSummary(graph);
  fs.writeFileSync(outputPath, summary, 'utf-8');
  return outputPath;
}

/**
 * Generate the markdown summary content.
 */
export function generateSummary(graph: GraphExport): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push('generated: true');
  lines.push(`generated_at: "${graph.generated_at}"`);
  lines.push('---');
  lines.push('');
  lines.push('# Graph Summary');
  lines.push('');

  // Total counts
  lines.push('## Overview');
  lines.push('');
  lines.push(`- **Total nodes:** ${graph.nodes.length}`);
  lines.push(`- **Total edges:** ${graph.edges.length}`);
  lines.push(`- **Orphan nodes:** ${graph.orphans.length}`);
  lines.push('');

  // Counts by node kind
  lines.push('## Nodes by Kind');
  lines.push('');
  const kindCounts: Record<string, number> = {};
  for (const node of graph.nodes) {
    kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
  }
  for (const kind of ['code_file', 'doc_file', 'wiki_record'] as const) {
    lines.push(`- **${kind}:** ${kindCounts[kind] ?? 0}`);
  }
  lines.push('');

  // Counts by edge relation
  lines.push('## Edges by Relation');
  lines.push('');
  const relationCounts: Record<string, number> = {};
  for (const edge of graph.edges) {
    relationCounts[edge.relation] = (relationCounts[edge.relation] ?? 0) + 1;
  }
  const allRelations: EdgeRelation[] = [
    'imports', 'repo_path', 'doc', 'depends_on', 'blocks',
    'related', 'area', 'initiative', 'markdown_link',
  ];
  for (const rel of allRelations) {
    const count = relationCounts[rel] ?? 0;
    if (count > 0) {
      lines.push(`- **${rel}:** ${count}`);
    }
  }
  lines.push('');

  // Orphan nodes
  lines.push('## Orphan Nodes');
  lines.push('');
  if (graph.orphans.length === 0) {
    lines.push('No orphan nodes.');
  } else {
    for (const orphan of graph.orphans) {
      lines.push(`- \`${orphan}\``);
    }
  }
  lines.push('');

  // Missing referenced nodes
  lines.push('## Missing Referenced Nodes');
  lines.push('');
  const missingNodes = graph.nodes.filter(n => !n.exists);
  if (missingNodes.length === 0) {
    lines.push('No missing referenced nodes.');
  } else {
    for (const node of missingNodes) {
      lines.push(`- \`${node.id}\` (${node.kind})`);
    }
  }
  lines.push('');

  // Highest in-degree nodes
  lines.push('## Highest In-Degree Nodes');
  lines.push('');
  const inDegree = new Map<string, number>();
  for (const edge of graph.edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const topN = 10;
  const sorted = Array.from(inDegree.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  if (sorted.length === 0) {
    lines.push('No edges in graph.');
  } else {
    for (const [nodeId, count] of sorted) {
      lines.push(`- \`${nodeId}\`: ${count}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
