/**
 * CLI entry point for graph extraction.
 *
 * Usage: npm run graph -- --dir <path>
 *
 * Produces:
 * - wiki/.graph.json
 * - wiki/graph-summary.md
 */

import * as path from 'node:path';
import { buildGraph, writeGraphJson, writeGraphSummary } from './graph.js';

function main(): void {
  const args = process.argv.slice(2);

  // Parse --dir argument
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && i + 1 < args.length) {
      dir = args[i + 1];
      break;
    }
  }

  if (!dir) {
    console.error('Usage: npm run graph -- --dir <path>');
    process.exit(1);
  }

  const repoRoot = path.resolve(dir);

  console.log(`Extracting graph from: ${repoRoot}`);

  const graph = buildGraph(repoRoot);

  const jsonPath = writeGraphJson(repoRoot, graph);
  const summaryPath = writeGraphSummary(repoRoot, graph);

  console.log(`Nodes: ${graph.nodes.length}`);
  console.log(`Edges: ${graph.edges.length}`);
  console.log(`Orphans: ${graph.orphans.length}`);
  console.log(`Wrote: ${jsonPath}`);
  console.log(`Wrote: ${summaryPath}`);
}

main();
