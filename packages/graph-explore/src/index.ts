export const VERSION = '0.0.1';

// Graph types
export type {
  NodeKind,
  GraphWikiPrefix,
  EdgeRelation,
  GraphNode,
  GraphEdge,
  GraphExport,
} from './types.js';

// Core graph functions
export { buildGraph, writeGraphJson, writeGraphSummary, generateSummary } from './graph.js';

// Scanner
export { scanDirectory, classifyFile, isExcluded } from './scan.js';

// Code extraction
export { extractImports, extractAllImports, resolveTsImport, resolvePyImport } from './code-extract.js';

// Wiki overlay
export { extractWikiEdges, extractAllWikiEdges, extractMarkdownLinks, parseRecord } from './wiki-overlay.js';
